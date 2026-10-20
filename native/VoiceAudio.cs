using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Step Voice Windows audio helper.
//
// JSONL over stdin/stdout, identical to the macOS helper contract:
//   in : {"type":"play","audio":"<base64 PCM16 24 kHz mono>","sampleRate":24000}
//        {"type":"clear"}
//        {"type":"mute","muted":true}
//        {"type":"stop"}
//   out: ready / audio / level / playback / error / notice / closed
//
// Capture and playback use WinMM waveIn/waveOut with polling instead of
// callbacks: buffers are returned by the driver, marked WHDR_DONE, and a
// single pump thread recycles them. This keeps memory ownership in one place
// and makes reset/clear races easy to reason about. Windows Vista and newer
// route WinMM through the shared-mode audio engine, so 24 kHz mono PCM16 is
// accepted without an explicit resampler.
internal static class Program
{
    private static readonly object OutputLock = new object();
    private static readonly StreamWriter Output =
        new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

    internal static void Emit(string json)
    {
        lock (OutputLock)
        {
            try
            {
                Output.Write(json);
                Output.Write("\n");
                Output.Flush();
            }
            catch
            {
                Environment.Exit(0);
            }
        }
    }

    internal static string JsonString(string value)
    {
        if (value == null) return "null";
        StringBuilder text = new StringBuilder(value.Length + 8);
        text.Append('"');
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '"') text.Append("\\\"");
            else if (character == '\\') text.Append("\\\\");
            else if (character == '\n') text.Append("\\n");
            else if (character == '\r') text.Append("\\r");
            else if (character == '\t') text.Append("\\t");
            else if (character < ' ') text.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else text.Append(character);
        }
        text.Append('"');
        return text.ToString();
    }

    private static void Main(string[] args)
    {
        bool echoCancel = Array.IndexOf(args, "--echo-cancel") >= 0;
        VoiceAudio audio = new VoiceAudio();
        if (!audio.Start(echoCancel)) Environment.Exit(1);
        Thread reader = new Thread(delegate() { ReadCommands(audio); });
        reader.IsBackground = true;
        reader.Name = "step-voice-command-reader";
        reader.Start();
        // Capture and playback run on the pump thread; keep the process alive.
        while (true) Thread.Sleep(1000);
    }

    private static void ReadCommands(VoiceAudio audio)
    {
        try
        {
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0 || line.Length > 400000) continue;
                string type = FieldString(line, "type");
                if (type == "play")
                {
                    double rate = 24000;
                    string rateText = FieldToken(line, "sampleRate");
                    if (rateText != null) double.TryParse(rateText, NumberStyles.Float, CultureInfo.InvariantCulture, out rate);
                    audio.Play(FieldString(line, "audio"), rate);
                }
                else if (type == "clear") audio.Clear();
                else if (type == "mute") audio.SetMuted(FieldToken(line, "muted") == "true");
                else if (type == "stop") break;
            }
        }
        catch (Exception)
        {
            // stdin closed by the host: shut down exactly like an explicit stop.
        }
        audio.Stop();
        Environment.Exit(0);
    }

    internal static string FieldString(string json, string name)
    {
        int at = ValueStart(json, name);
        if (at < 0 || at >= json.Length || json[at] != '"') return null;
        at++;
        StringBuilder value = new StringBuilder();
        while (at < json.Length)
        {
            char character = json[at++];
            if (character == '"') return value.ToString();
            if (character != '\\' || at >= json.Length)
            {
                value.Append(character);
                continue;
            }
            char escaped = json[at++];
            if (escaped == 'n') value.Append('\n');
            else if (escaped == 'r') value.Append('\r');
            else if (escaped == 't') value.Append('\t');
            else if (escaped == 'b') value.Append('\b');
            else if (escaped == 'f') value.Append('\f');
            else if (escaped == 'u')
            {
                if (at + 4 <= json.Length)
                {
                    int code;
                    if (int.TryParse(json.Substring(at, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                    {
                        value.Append((char)code);
                        at += 4;
                        continue;
                    }
                }
                value.Append('u');
            }
            else value.Append(escaped);
        }
        return value.ToString();
    }

    internal static string FieldToken(string json, string name)
    {
        int at = ValueStart(json, name);
        if (at < 0) return null;
        int end = at;
        while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ' ') end++;
        return json.Substring(at, end - at);
    }

    private static int ValueStart(string json, string name)
    {
        int marker = json.IndexOf("\"" + name + "\"", StringComparison.Ordinal);
        if (marker < 0) return -1;
        int colon = json.IndexOf(':', marker + name.Length + 2);
        if (colon < 0) return -1;
        int at = colon + 1;
        while (at < json.Length && json[at] == ' ') at++;
        return at;
    }
}

internal sealed class VoiceAudio
{
    private const int SampleRate = 24000;
    private const int CaptureChunkBytes = 1920; // 40 ms of PCM16 mono at 24 kHz
    private const int CaptureBufferCount = 6;
    private const int MaxPlaybackBytes = 262144;
    private const int MaxPlaybackFrames = SampleRate * 30;

    private const uint WaveMapper = 0xFFFFFFFF;
    private const uint WaveFormatPcm = 1;
    private const uint HeaderDone = 0x00000001;
    private const int ErrorSuccess = 0;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WaveFormat
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSecond;
        public uint AverageBytesPerSecond;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader
    {
        public IntPtr Data;
        public uint BufferLength;
        public uint BytesRecorded;
        public IntPtr User;
        public uint Flags;
        public uint Loops;
        public IntPtr Next;
        public IntPtr Reserved;
    }

    private sealed class PlaybackBuffer
    {
        public IntPtr Data;
        public IntPtr Header;
        public int Frames;
        public int Epoch;
    }

    private sealed class CaptureBuffer
    {
        public IntPtr Data;
        public IntPtr Header;
    }

    [DllImport("winmm.dll")]
    private static extern int waveOutOpen(out IntPtr device, uint deviceId, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")]
    private static extern int waveOutPrepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveOutUnprepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveOutWrite(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveOutReset(IntPtr device);
    [DllImport("winmm.dll")]
    private static extern int waveOutClose(IntPtr device);

    [DllImport("winmm.dll")]
    private static extern int waveInOpen(out IntPtr device, uint deviceId, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")]
    private static extern int waveInPrepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveInUnprepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveInAddBuffer(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern int waveInStart(IntPtr device);
    [DllImport("winmm.dll")]
    private static extern int waveInReset(IntPtr device);
    [DllImport("winmm.dll")]
    private static extern int waveInClose(IntPtr device);

    private static readonly int HeaderSize = Marshal.SizeOf(typeof(WaveHeader));

    private readonly object gate = new object();
    private readonly Dictionary<IntPtr, PlaybackBuffer> inflight = new Dictionary<IntPtr, PlaybackBuffer>();
    private readonly List<CaptureBuffer> captureBuffers = new List<CaptureBuffer>();
    private IntPtr playback = IntPtr.Zero;
    private IntPtr capture = IntPtr.Zero;
    private int pendingFrames;
    private int playbackEpoch;
    private bool playing;
    private bool muted;
    private bool stopped;
    private bool captureFailed;
    private long capturedFrames;

    public bool Start(bool echoCancel)
    {
        if (echoCancel)
        {
            Program.Emit("{\"type\":\"notice\",\"message\":" +
                Program.JsonString("Windows 版暂不支持系统回声消除；请使用耳机以避免外放回声。") + "}");
        }
        if (!OpenPlayback()) return false;
        if (!OpenCapture())
        {
            ClosePlayback();
            return false;
        }
        if (!QueueCapture())
        {
            CloseCapture();
            ClosePlayback();
            return false;
        }
        int started = waveInStart(capture);
        if (started != ErrorSuccess)
        {
            Fail("无法启动麦克风采集（" + started + "）。请检查输入设备是否被其他应用独占。");
            CloseCapture();
            ClosePlayback();
            return false;
        }
        Program.Emit("{\"type\":\"ready\",\"inputSampleRate\":24000,\"sampleRate\":24000,\"voiceProcessing\":false}");
        Thread pump = new Thread(Pump);
        pump.IsBackground = true;
        pump.Name = "step-voice-audio-pump";
        pump.Start();
        Thread watchdog = new Thread(WatchInput);
        watchdog.IsBackground = true;
        watchdog.Name = "step-voice-input-watchdog";
        watchdog.Start();
        return true;
    }

    private static WaveFormat BuildFormat()
    {
        WaveFormat format = new WaveFormat();
        format.FormatTag = (ushort)WaveFormatPcm;
        format.Channels = 1;
        format.SamplesPerSecond = SampleRate;
        format.BitsPerSample = 16;
        format.BlockAlign = 2;
        format.AverageBytesPerSecond = SampleRate * 2;
        format.ExtraSize = 0;
        return format;
    }

    private bool OpenPlayback()
    {
        WaveFormat format = BuildFormat();
        int result = waveOutOpen(out playback, WaveMapper, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        if (result == ErrorSuccess) return true;
        playback = IntPtr.Zero;
        Fail("无法打开扬声器输出（waveOutOpen " + result + "）。请检查 Windows 默认播放设备。");
        return false;
    }

    private bool OpenCapture()
    {
        WaveFormat format = BuildFormat();
        int result = waveInOpen(out capture, WaveMapper, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        if (result == ErrorSuccess) return true;
        capture = IntPtr.Zero;
        Fail("无法打开麦克风（waveInOpen " + result + "）。请到 Windows 设置 → 隐私和安全性 → 麦克风 允许桌面应用访问，并检查输入设备。");
        return false;
    }

    private bool QueueCapture()
    {
        for (int index = 0; index < CaptureBufferCount; index++)
        {
            CaptureBuffer buffer = new CaptureBuffer();
            buffer.Data = Marshal.AllocHGlobal(CaptureChunkBytes);
            buffer.Header = Marshal.AllocHGlobal(HeaderSize);
            WaveHeader header = new WaveHeader();
            header.Data = buffer.Data;
            header.BufferLength = CaptureChunkBytes;
            Marshal.StructureToPtr(header, buffer.Header, false);
            int result = waveInPrepareHeader(capture, buffer.Header, (uint)HeaderSize);
            if (result != ErrorSuccess)
            {
                Marshal.FreeHGlobal(buffer.Data);
                Marshal.FreeHGlobal(buffer.Header);
                Fail("无法准备麦克风缓冲区（" + result + "）。");
                return false;
            }
            result = waveInAddBuffer(capture, buffer.Header, (uint)HeaderSize);
            if (result != ErrorSuccess)
            {
                waveInUnprepareHeader(capture, buffer.Header, (uint)HeaderSize);
                Marshal.FreeHGlobal(buffer.Data);
                Marshal.FreeHGlobal(buffer.Header);
                Fail("无法启动麦克风采集（" + result + "）。");
                return false;
            }
            captureBuffers.Add(buffer);
        }
        return true;
    }

    private void Pump()
    {
        while (true)
        {
            lock (gate)
            {
                if (stopped) return;
                PumpPlayback();
                PumpCapture();
            }
            Thread.Sleep(10);
        }
    }

    private void PumpPlayback()
    {
        if (inflight.Count == 0) return;
        List<IntPtr> done = null;
        foreach (KeyValuePair<IntPtr, PlaybackBuffer> entry in inflight)
        {
            WaveHeader header = (WaveHeader)Marshal.PtrToStructure(entry.Value.Header, typeof(WaveHeader));
            if ((header.Flags & HeaderDone) == 0) continue;
            if (done == null) done = new List<IntPtr>();
            done.Add(entry.Key);
        }
        if (done == null) return;
        foreach (IntPtr pointer in done)
        {
            PlaybackBuffer buffer = inflight[pointer];
            inflight.Remove(pointer);
            waveOutUnprepareHeader(playback, buffer.Header, (uint)HeaderSize);
            Marshal.FreeHGlobal(buffer.Data);
            Marshal.FreeHGlobal(buffer.Header);
            if (buffer.Epoch == playbackEpoch && pendingFrames > 0)
            {
                pendingFrames -= buffer.Frames;
                if (pendingFrames < 0) pendingFrames = 0;
            }
        }
        if (playing && pendingFrames == 0)
        {
            playing = false;
            Program.Emit("{\"type\":\"playback\",\"active\":false}");
        }
    }

    private void PumpCapture()
    {
        if (capture == IntPtr.Zero) return;
        // Iterate backwards so a broken buffer can be removed without disturbing
        // the remaining ones; a failed re-arm is reported once, not every tick.
        for (int index = captureBuffers.Count - 1; index >= 0; index--)
        {
            CaptureBuffer buffer = captureBuffers[index];
            WaveHeader header = (WaveHeader)Marshal.PtrToStructure(buffer.Header, typeof(WaveHeader));
            if ((header.Flags & HeaderDone) == 0) continue;
            int bytes = (int)header.BytesRecorded;
            if (bytes <= 0 || bytes > CaptureChunkBytes) bytes = CaptureChunkBytes;
            capturedFrames += bytes / 2;
            if (!muted && !stopped)
            {
                byte[] data = new byte[bytes];
                Marshal.Copy(buffer.Data, data, 0, bytes);
                Program.Emit("{\"type\":\"level\",\"value\":" + Level(data).ToString("0.####", CultureInfo.InvariantCulture) + "}");
                Program.Emit("{\"type\":\"audio\",\"audio\":\"" + Convert.ToBase64String(data) + "\",\"sampleRate\":24000}");
            }
            waveInUnprepareHeader(capture, buffer.Header, (uint)HeaderSize);
            WaveHeader recycled = new WaveHeader();
            recycled.Data = buffer.Data;
            recycled.BufferLength = CaptureChunkBytes;
            recycled.Flags = 0;
            Marshal.StructureToPtr(recycled, buffer.Header, false);
            int prepared = waveInPrepareHeader(capture, buffer.Header, (uint)HeaderSize);
            if (prepared != ErrorSuccess)
            {
                Marshal.FreeHGlobal(buffer.Data);
                Marshal.FreeHGlobal(buffer.Header);
                captureBuffers.RemoveAt(index);
                ReportCaptureFailure(prepared);
                continue;
            }
            int added = waveInAddBuffer(capture, buffer.Header, (uint)HeaderSize);
            if (added != ErrorSuccess)
            {
                waveInUnprepareHeader(capture, buffer.Header, (uint)HeaderSize);
                Marshal.FreeHGlobal(buffer.Data);
                Marshal.FreeHGlobal(buffer.Header);
                captureBuffers.RemoveAt(index);
                ReportCaptureFailure(added);
            }
        }
    }

    private void ReportCaptureFailure(int code)
    {
        if (captureFailed) return;
        captureFailed = true;
        Fail("麦克风采集中断（" + code + "）。请重新开始语音。");
    }

    private static double Level(byte[] data)
    {
        int samples = data.Length / 2;
        if (samples <= 0) return 0;
        double sum = 0;
        for (int index = 0; index < samples; index++)
        {
            short sample = (short)(data[index * 2] | (data[index * 2 + 1] << 8));
            double value = sample / 32768.0;
            sum += value * value;
        }
        return Math.Sqrt(sum / samples);
    }

    public void Play(string audio, double rate)
    {
        if (rate != SampleRate)
        {
            Fail("播放音频必须是 24 kHz 单声道 PCM16");
            return;
        }
        byte[] data;
        try
        {
            data = Convert.FromBase64String(audio ?? string.Empty);
        }
        catch (Exception)
        {
            Fail("播放音频必须是 24 kHz 单声道 PCM16");
            return;
        }
        if (data.Length <= 0 || data.Length % 2 != 0 || data.Length > MaxPlaybackBytes)
        {
            Fail("播放音频必须是 24 kHz 单声道 PCM16");
            return;
        }
        int frames = data.Length / 2;
        lock (gate)
        {
            if (stopped || playback == IntPtr.Zero) return;
            if (pendingFrames + frames >= MaxPlaybackFrames)
            {
                ClearLocked();
                Program.Emit("{\"type\":\"notice\",\"message\":" +
                    Program.JsonString("待播放音频超过 30 秒，已清空播放队列。") + "}");
                return;
            }
            IntPtr dataPointer = Marshal.AllocHGlobal(data.Length);
            Marshal.Copy(data, 0, dataPointer, data.Length);
            IntPtr headerPointer = Marshal.AllocHGlobal(HeaderSize);
            WaveHeader header = new WaveHeader();
            header.Data = dataPointer;
            header.BufferLength = (uint)data.Length;
            Marshal.StructureToPtr(header, headerPointer, false);
            int result = waveOutPrepareHeader(playback, headerPointer, (uint)HeaderSize);
            if (result != ErrorSuccess)
            {
                Marshal.FreeHGlobal(dataPointer);
                Marshal.FreeHGlobal(headerPointer);
                Fail("无法准备播放缓冲区（" + result + "）。");
                return;
            }
            result = waveOutWrite(playback, headerPointer, (uint)HeaderSize);
            if (result != ErrorSuccess)
            {
                waveOutUnprepareHeader(playback, headerPointer, (uint)HeaderSize);
                Marshal.FreeHGlobal(dataPointer);
                Marshal.FreeHGlobal(headerPointer);
                Fail("无法写入播放缓冲区（" + result + "）。");
                return;
            }
            PlaybackBuffer buffer = new PlaybackBuffer();
            buffer.Data = dataPointer;
            buffer.Header = headerPointer;
            buffer.Frames = frames;
            buffer.Epoch = playbackEpoch;
            inflight[headerPointer] = buffer;
            pendingFrames += frames;
            if (!playing)
            {
                playing = true;
                Program.Emit("{\"type\":\"playback\",\"active\":true}");
            }
        }
    }

    public void Clear()
    {
        lock (gate)
        {
            if (stopped) return;
            ClearLocked();
        }
    }

    private void ClearLocked()
    {
        playbackEpoch++;
        pendingFrames = 0;
        if (playback != IntPtr.Zero) waveOutReset(playback);
        foreach (PlaybackBuffer buffer in inflight.Values)
        {
            waveOutUnprepareHeader(playback, buffer.Header, (uint)HeaderSize);
            Marshal.FreeHGlobal(buffer.Data);
            Marshal.FreeHGlobal(buffer.Header);
        }
        inflight.Clear();
        if (playing)
        {
            playing = false;
            Program.Emit("{\"type\":\"playback\",\"active\":false}");
        }
    }

    public void SetMuted(bool value)
    {
        lock (gate)
        {
            muted = value;
            if (muted) Program.Emit("{\"type\":\"level\",\"value\":0}");
        }
    }

    public void Stop()
    {
        lock (gate)
        {
            if (stopped) return;
            stopped = true;
            pendingFrames = 0;
            playing = false;
            if (capture != IntPtr.Zero) waveInReset(capture);
            if (playback != IntPtr.Zero) waveOutReset(playback);
        }
        CloseCapture();
        ClosePlayback();
        Program.Emit("{\"type\":\"closed\"}");
    }

    private void CloseCapture()
    {
        if (capture == IntPtr.Zero) return;
        waveInReset(capture);
        foreach (CaptureBuffer buffer in captureBuffers)
        {
            waveInUnprepareHeader(capture, buffer.Header, (uint)HeaderSize);
            Marshal.FreeHGlobal(buffer.Data);
            Marshal.FreeHGlobal(buffer.Header);
        }
        captureBuffers.Clear();
        waveInClose(capture);
        capture = IntPtr.Zero;
    }

    private void ClosePlayback()
    {
        if (playback == IntPtr.Zero) return;
        waveOutReset(playback);
        foreach (PlaybackBuffer buffer in inflight.Values)
        {
            waveOutUnprepareHeader(playback, buffer.Header, (uint)HeaderSize);
            Marshal.FreeHGlobal(buffer.Data);
            Marshal.FreeHGlobal(buffer.Header);
        }
        inflight.Clear();
        waveOutClose(playback);
        playback = IntPtr.Zero;
    }

    private void WatchInput()
    {
        Thread.Sleep(3000);
        lock (gate)
        {
            if (stopped || capturedFrames > 0) return;
            Program.Emit("{\"type\":\"notice\",\"message\":" +
                Program.JsonString("麦克风已打开但 3 秒内未收到任何数据：请到 Windows 设置 → 隐私和安全性 → 麦克风 允许桌面应用访问，并重新选择输入设备后重启语音。") + "}");
        }
    }

    private static void Fail(string message)
    {
        Program.Emit("{\"type\":\"error\",\"message\":" + Program.JsonString(message) + "}");
    }
}
