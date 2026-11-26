# Keeps this Windows computer from falling asleep while Hearth has work: bots with Telegram or a schedule, a bot's
# task, or the model answering a chat or an app. Hearth starts it and stops it, and it ends by itself when Hearth
# closes (its input closes). The screen may still turn off, and sleep chosen by hand still works.
# How: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) on one thread, held until the input closes.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HearthKeepAwake {
    [DllImport("kernel32.dll")]
    static extern uint SetThreadExecutionState(uint flags);
    public static int Hold() {
        if (SetThreadExecutionState(0x80000001u) == 0) return 1;
        Console.Out.WriteLine("awake");
        Console.Out.Flush();
        Console.In.ReadLine();
        SetThreadExecutionState(0x80000000u);
        return 0;
    }
}
'@
exit [HearthKeepAwake]::Hold()
