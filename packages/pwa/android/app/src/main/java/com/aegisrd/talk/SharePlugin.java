package com.aegisrd.talk;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * SharePlugin — 處理 Android ACTION_SEND / ACTION_SEND_MULTIPLE Intent
 *
 * 當用戶從其他 App 分享檔案到 AegisTalk 時，
 * 此 Plugin 從 Intent 中提取分享的資料（文字、檔案）
 * 並轉換為 JS 可讀的格式（base64 data URL）。
 */
@CapacitorPlugin(name = "SharePlugin")
public class SharePlugin extends Plugin {
    private static final String TAG = "SharePlugin";
    private static final int MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

    /**
     * singleTask 模式下，分享 Intent 走 onNewIntent()。
     * MainActivity.onNewIntent() 已呼叫 setIntent()，
     * 這裡通知 JS 層有新的分享 Intent 到達。
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            Log.d(TAG, "New share intent received via onNewIntent");
            notifyListeners("shareReceived", new JSObject());
        }
    }

    /**
     * 檢查是否有待處理的分享 Intent
     * Returns: { hasShare: boolean, text?: string, files?: [...] }
     */
    @PluginMethod
    public void checkShare(PluginCall call) {
        try {
            Intent intent = getActivity().getIntent();
            if (intent == null) {
                call.resolve(noShare());
                return;
            }

            String action = intent.getAction();
            String type = intent.getType();

            if (action == null || type == null) {
                call.resolve(noShare());
                return;
            }

            JSObject result = new JSObject();

            if (Intent.ACTION_SEND.equals(action)) {
                result.put("hasShare", true);

                // 文字內容
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (text != null) {
                    result.put("text", text);
                }

                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (subject != null) {
                    result.put("title", subject);
                }

                // 單一檔案
                Uri fileUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (fileUri != null) {
                    JSArray files = new JSArray();
                    JSObject fileObj = uriToJSObject(fileUri);
                    if (fileObj != null) {
                        files.put(fileObj);
                    }
                    result.put("files", files);
                } else {
                    result.put("files", new JSArray());
                }

                // 如果只有文字沒有檔案，也算有分享
                if (fileUri == null && text == null) {
                    call.resolve(noShare());
                    return;
                }

                call.resolve(result);

            } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                result.put("hasShare", true);

                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (text != null) {
                    result.put("text", text);
                }

                // 多檔案
                ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                JSArray files = new JSArray();
                if (uris != null) {
                    for (Uri uri : uris) {
                        JSObject fileObj = uriToJSObject(uri);
                        if (fileObj != null) {
                            files.put(fileObj);
                        }
                    }
                }
                result.put("files", files);

                call.resolve(result);

            } else {
                call.resolve(noShare());
            }

        } catch (Exception e) {
            Log.e(TAG, "checkShare error", e);
            call.resolve(noShare());
        }
    }

    /**
     * 清除分享 Intent，防止重複觸發
     */
    @PluginMethod
    public void clearShare(PluginCall call) {
        try {
            Intent intent = getActivity().getIntent();
            if (intent != null) {
                intent.setAction(null);
                intent.removeExtra(Intent.EXTRA_STREAM);
                intent.removeExtra(Intent.EXTRA_TEXT);
                intent.removeExtra(Intent.EXTRA_SUBJECT);
            }
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "clearShare error", e);
            JSObject ret = new JSObject();
            ret.put("success", false);
            call.resolve(ret);
        }
    }

    /**
     * 將 content URI 轉換為 JS 可讀的檔案物件
     * { name, mimeType, size, dataUrl }
     */
    private JSObject uriToJSObject(Uri uri) {
        try {
            ContentResolver resolver = getContext().getContentResolver();

            // 取得 MIME type
            String mimeType = resolver.getType(uri);
            if (mimeType == null) {
                mimeType = "application/octet-stream";
            }

            // 取得檔名和大小
            String fileName = "shared_file";
            long fileSize = 0;

            Cursor cursor = resolver.query(uri, null, null, null, null);
            if (cursor != null) {
                try {
                    if (cursor.moveToFirst()) {
                        int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (nameIndex >= 0) {
                            fileName = cursor.getString(nameIndex);
                        }
                        int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (sizeIndex >= 0) {
                            fileSize = cursor.getLong(sizeIndex);
                        }
                    }
                } finally {
                    cursor.close();
                }
            }

            // 檢查檔案大小
            if (fileSize > MAX_FILE_SIZE) {
                Log.w(TAG, "File too large, skipping: " + fileName + " (" + fileSize + " bytes)");
                return null;
            }

            // 讀取檔案內容 → base64 data URL
            InputStream inputStream = resolver.openInputStream(uri);
            if (inputStream == null) {
                Log.w(TAG, "Cannot open input stream for: " + uri);
                return null;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int bytesRead;
            long totalRead = 0;

            while ((bytesRead = inputStream.read(chunk)) != -1) {
                totalRead += bytesRead;
                if (totalRead > MAX_FILE_SIZE) {
                    inputStream.close();
                    Log.w(TAG, "File exceeded max size during read: " + fileName);
                    return null;
                }
                buffer.write(chunk, 0, bytesRead);
            }
            inputStream.close();

            byte[] bytes = buffer.toByteArray();
            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            String dataUrl = "data:" + mimeType + ";base64," + base64;

            JSObject fileObj = new JSObject();
            fileObj.put("name", fileName);
            fileObj.put("mimeType", mimeType);
            fileObj.put("size", bytes.length);
            fileObj.put("dataUrl", dataUrl);

            Log.d(TAG, "Converted file: " + fileName + " (" + bytes.length + " bytes, " + mimeType + ")");
            return fileObj;

        } catch (Exception e) {
            Log.e(TAG, "uriToJSObject error for " + uri, e);
            return null;
        }
    }

    private JSObject noShare() {
        JSObject ret = new JSObject();
        ret.put("hasShare", false);
        ret.put("files", new JSArray());
        return ret;
    }
}
