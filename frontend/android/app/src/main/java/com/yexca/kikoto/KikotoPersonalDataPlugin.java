package com.yexca.kikoto;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/** Saves only a user-requested personal export to the system-selected document. */
@CapacitorPlugin(name = "KikotoPersonalData")
public class KikotoPersonalDataPlugin extends Plugin {
    private static final int MAX_EXPORT_BYTES = 10 * 1024 * 1024;
    private final AtomicBoolean exportPending = new AtomicBoolean(false);

    @PluginMethod
    public void saveExport(PluginCall call) {
        String data = call.getString("data", "");
        if (data.length() > MAX_EXPORT_BYTES || data.getBytes(StandardCharsets.UTF_8).length > MAX_EXPORT_BYTES) {
            call.reject("Personal export is too large.");
            return;
        }
        try {
            JSONObject document = new JSONObject(data);
            if (!"kikoto-user-data".equals(document.optString("format")) || document.optInt("version") != 1) {
                call.reject("Unsupported personal export.");
                return;
            }
        } catch (JSONException error) {
            call.reject("Invalid personal export.");
            return;
        }
        if (!exportPending.compareAndSet(false, true)) {
            call.reject("An export is already open.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, "kikoto-user-data.json");
        try {
            startActivityForResult(call, intent, "exportResult");
        } catch (RuntimeException error) {
            exportPending.set(false);
            call.reject("Unable to open the document picker.");
        }
    }

    @ActivityCallback
    private void exportResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            exportPending.set(false);
            return;
        }
        Intent intent = result.getData();
        Uri destination = intent == null ? null : intent.getData();
        if (result.getResultCode() != Activity.RESULT_OK || destination == null) {
            exportPending.set(false);
            JSObject response = new JSObject();
            response.put("saved", false);
            call.resolve(response);
            return;
        }
        // The picker grants access to exactly this content URI, with no broad
        // storage permission or filesystem path accepted from JavaScript.
        if (!"content".equals(destination.getScheme())) {
            exportPending.set(false);
            call.reject("Unsupported document destination.");
            return;
        }
        getBridge().execute(() -> {
            try {
                try (OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new IOException("Missing document stream");
                    byte[] data = call.getString("data", "").getBytes(StandardCharsets.UTF_8);
                    if (data.length > MAX_EXPORT_BYTES) throw new IOException("Export exceeds limit");
                    output.write(data);
                    output.flush();
                }
                JSObject response = new JSObject();
                response.put("saved", true);
                call.resolve(response);
            } catch (IOException | RuntimeException error) {
                call.reject("Unable to save the personal export.");
            } finally {
                exportPending.set(false);
            }
        });
    }
}
