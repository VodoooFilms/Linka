using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const int VK_CONTROL = 0x11;
    private static readonly Guid VolumeEventContext = Guid.NewGuid();

    private static int Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                Handle(document.RootElement);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"NativeInput error: {error.Message}");
            }
        }

        return 0;
    }

    private static void Handle(JsonElement command)
    {
        var type = GetString(command, "type");

        switch (type)
        {
            case "move":
                Move(GetInt(command, "dx"), GetInt(command, "dy"));
                break;
            case "mousedown":
                MouseButton(GetString(command, "button") ?? "left", true);
                break;
            case "mouseup":
                MouseButton(GetString(command, "button") ?? "left", false);
                break;
            case "click":
                Click(GetString(command, "button") ?? "left", GetBool(command, "double"));
                break;
            case "scroll":
                Scroll(GetInt(command, "dy"));
                break;
            case "zoom":
                Zoom(GetString(command, "direction") ?? "in");
                break;
            case "type":
                TypeText(GetString(command, "text") ?? string.Empty);
                break;
            case "keytap":
                KeyTap(GetString(command, "key") ?? string.Empty, GetStringArray(command, "modifiers"));
                break;
            case "volume":
                SetVolume(GetFloat(command, "value"));
                break;
            case "mute":
                SetMute(GetBool(command, "muted"));
                break;
            case "togglemute":
                ToggleMute();
                break;
            case "getvolume":
                GetVolumeState();
                break;
        }
    }

    private static void Move(int dx, int dy)
    {
        SendMouse(dx, dy, 0, MOUSEEVENTF_MOVE);
    }

    private static void MouseButton(string button, bool down)
    {
        var flags = button.Equals("right", StringComparison.OrdinalIgnoreCase)
            ? down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP
            : down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;

        SendMouse(0, 0, 0, flags);
    }

    private static void Click(string button, bool doubleClick)
    {
        var count = doubleClick ? 2 : 1;
        for (var i = 0; i < count; i++)
        {
            MouseButton(button, true);
            Thread.Sleep(18);
            MouseButton(button, false);
            if (i + 1 < count)
            {
                Thread.Sleep(70);
            }
        }
    }

    private static void Scroll(int dy)
    {
        var wheelData = Math.Clamp(dy, -2400, 2400);
        if (wheelData != 0)
        {
            SendMouse(0, 0, wheelData, MOUSEEVENTF_WHEEL);
        }
    }

    private static void Zoom(string direction)
    {
        var wheelData = direction.Equals("out", StringComparison.OrdinalIgnoreCase) ? -120 : 120;

        SendKeyboard('\0', VK_CONTROL, 0);
        SendMouse(0, 0, wheelData, MOUSEEVENTF_WHEEL);
        SendKeyboard('\0', VK_CONTROL, KEYEVENTF_KEYUP);
    }

    private static void TypeText(string text)
    {
        foreach (var character in text)
        {
            SendUnicode(character);
        }
    }

    private static void SendUnicode(char character)
    {
        SendKeyboard(character, 0, KEYEVENTF_UNICODE);
        SendKeyboard(character, 0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    private static void KeyTap(string key, IReadOnlyList<string> modifiers)
    {
        var virtualKey = GetVirtualKey(key);

        if (virtualKey == 0)
        {
            Console.Error.WriteLine($"Unknown key: {key}");
            return;
        }

        var modifierKeys = modifiers
            .Select(GetVirtualKey)
            .Where(value => value != 0)
            .Distinct()
            .ToArray();

        foreach (var modifierKey in modifierKeys)
        {
            SendKeyboard('\0', modifierKey, 0);
        }

        SendKeyboard('\0', virtualKey, 0);
        SendKeyboard('\0', virtualKey, KEYEVENTF_KEYUP);

        for (var i = modifierKeys.Length - 1; i >= 0; i--)
        {
            SendKeyboard('\0', modifierKeys[i], KEYEVENTF_KEYUP);
        }
    }

    private static int GetVirtualKey(string key)
    {
        if (key.Length == 1 && char.IsLetterOrDigit(key[0]))
        {
            return char.ToUpperInvariant(key[0]);
        }

        return key.ToLowerInvariant() switch
        {
            "enter" => 0x0D,
            "backspace" => 0x08,
            "escape" or "esc" => 0x1B,
            "tab" => 0x09,
            "ctrl" or "control" => 0x11,
            "shift" => 0x10,
            "alt" => 0x12,
            _ => 0,
        };
    }

    private static void SetVolume(float value)
    {
        using var endpoint = GetAudioEndpointVolume();
        var context = VolumeEventContext;
        endpoint.Value.SetMasterVolumeLevelScalar(Math.Clamp(value, 0f, 1f), ref context);
    }

    private static void SetMute(bool muted)
    {
        using var endpoint = GetAudioEndpointVolume();
        var context = VolumeEventContext;
        Marshal.ThrowExceptionForHR(endpoint.Value.SetMute(muted, ref context));
    }

    private static void ToggleMute()
    {
        using var endpoint = GetAudioEndpointVolume();
        Marshal.ThrowExceptionForHR(endpoint.Value.GetMute(out var muted));
        var context = VolumeEventContext;
        Marshal.ThrowExceptionForHR(endpoint.Value.SetMute(!muted, ref context));
    }

    private static void GetVolumeState()
    {
        using var endpoint = GetAudioEndpointVolume();
        Marshal.ThrowExceptionForHR(endpoint.Value.GetMasterVolumeLevelScalar(out var volume));
        Marshal.ThrowExceptionForHR(endpoint.Value.GetMute(out var muted));
        var response = JsonSerializer.Serialize(new
        {
            type = "volume_state",
            volume = Math.Round(volume, 4),
            muted,
        });
        Console.Out.WriteLine(response);
    }

    private static void SendMouse(int dx, int dy, int mouseData, uint flags)
    {
        var input = new INPUT
        {
            type = INPUT_MOUSE,
            U = new InputUnion
            {
                mi = new MOUSEINPUT
                {
                    dx = dx,
                    dy = dy,
                    mouseData = mouseData,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = UIntPtr.Zero,
                }
            }
        };

        var sent = SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
        if (sent != 1)
        {
            Console.Error.WriteLine($"SendInput failed: {Marshal.GetLastWin32Error()}");
        }
    }

    private static void SendKeyboard(char unicodeChar, int virtualKey, uint flags)
    {
        var input = new INPUT
        {
            type = INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = (ushort)virtualKey,
                    wScan = unicodeChar,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = UIntPtr.Zero,
                }
            }
        };

        var sent = SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
        if (sent != 1)
        {
            Console.Error.WriteLine($"SendInput keyboard failed: {Marshal.GetLastWin32Error()}");
        }
    }

    private static ComReleaser<IAudioEndpointVolume> GetAudioEndpointVolume()
    {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator
            ?? throw new InvalidOperationException("Could not create audio device enumerator.");

        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

        var iid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.CLSCTX_ALL, IntPtr.Zero, out var endpoint));
        Marshal.ReleaseComObject(device);
        Marshal.ReleaseComObject(enumerator);

        return new ComReleaser<IAudioEndpointVolume>((IAudioEndpointVolume)endpoint);
    }

    private static string? GetString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int GetInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return 0;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out var intValue) => intValue,
            JsonValueKind.Number => (int)Math.Round(value.GetDouble()),
            _ => 0,
        };
    }

    private static float GetFloat(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number)
        {
            return 0;
        }

        return value.TryGetSingle(out var singleValue) ? singleValue : (float)value.GetDouble();
    }

    private static IReadOnlyList<string> GetStringArray(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var strings = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { } text)
            {
                strings.Add(text);
            }
        }

        return strings;
    }

    private static bool GetBool(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            && value.GetBoolean();
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    private sealed class ComReleaser<T> : IDisposable
    {
        public ComReleaser(T value)
        {
            Value = value;
        }

        public T Value { get; }

        public void Dispose()
        {
            if (Value is not null && Marshal.IsComObject(Value))
            {
                Marshal.ReleaseComObject(Value);
            }
        }
    }

    private enum EDataFlow
    {
        eRender = 0,
    }

    private enum ERole
    {
        eMultimedia = 1,
    }

    [Flags]
    private enum CLSCTX : uint
    {
        CLSCTX_ALL = 23,
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints();
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, CLSCTX dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }
}
