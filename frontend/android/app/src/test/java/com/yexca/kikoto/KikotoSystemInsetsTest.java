package com.yexca.kikoto;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class KikotoSystemInsetsTest {
    @Test
    public void publishesEachBarInCssPixels() {
        String script = KikotoSystemInsets.safeAreaScript(96, 0, 63, 12, false, 2.625f);
        assertTrue(script.contains("'--native-safe-area-top','37px'"));
        assertTrue(script.contains("'--native-safe-area-right','0px'"));
        assertTrue(script.contains("'--native-safe-area-bottom','24px'"));
        assertTrue(script.contains("'--native-safe-area-left','5px'"));
    }

    @Test
    public void openKeyboardLeavesNoBottomInset() {
        String script = KikotoSystemInsets.safeAreaScript(96, 0, 63, 0, true, 2.625f);
        assertTrue(script.contains("'--native-safe-area-top','37px'"));
        assertTrue(script.contains("'--native-safe-area-bottom','0px'"));
    }
}
