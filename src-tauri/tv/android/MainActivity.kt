package com.hghubx.tv

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
  @Volatile private var pendingUpdateInstall = false

  private fun cachedUpdateFile(): File = File(cacheDir, "updates/hghubx-tv-update.apk")

  private fun canRequestInstall(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

  private fun launchPackageInstaller(apk: File): String {
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(intent)
    return "launched"
  }

  private fun installOnUiThread(): String {
    val apk = cachedUpdateFile()
    if (!apk.isFile || apk.length() <= 4L) return "missing"
    if (!canRequestInstall()) {
      pendingUpdateInstall = true
      try {
        startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:$packageName")
          )
        )
        return "permission_requested"
      } catch (_: Exception) {
        pendingUpdateInstall = false
      }
    }
    return try {
      launchPackageInstaller(apk)
    } catch (_: Exception) {
      "failed"
    }
  }

  inner class TvApkInstaller {
    @JavascriptInterface
    fun canInstall(): Boolean = canRequestInstall()

    @JavascriptInterface
    fun hasCachedUpdate(): Boolean {
      val apk = cachedUpdateFile()
      return apk.isFile && apk.length() > 4L
    }

    @JavascriptInterface
    fun installCachedUpdate(): String {
      if (Looper.myLooper() == Looper.getMainLooper()) {
        return installOnUiThread()
      }
      var outcome = "failed"
      val latch = CountDownLatch(1)
      runOnUiThread {
        try {
          outcome = installOnUiThread()
        } finally {
          latch.countDown()
        }
      }
      latch.await(3, TimeUnit.SECONDS)
      return outcome
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(TvApkInstaller(), "HGhubXTvInstaller")
  }

  override fun onResume() {
    super.onResume()
    if (pendingUpdateInstall) {
      pendingUpdateInstall = false
      if (canRequestInstall()) {
        val apk = cachedUpdateFile()
        if (apk.isFile && apk.length() > 4L) {
          try {
            launchPackageInstaller(apk)
          } catch (_: Exception) {}
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Android 15/16 can enforce edge-to-edge. Give the native content container
    // sole ownership of reported system-bar, cutout and keyboard insets instead
    // of relying on decor fitting or interpreting a zero cutout as no bars.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val content = findViewById<View>(android.R.id.content)
    content.fitsSystemWindows = false
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      // The WebView already occupies the fitted content area. Do not expose the
      // same insets again as CSS safe-area padding inside that smaller viewport.
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
