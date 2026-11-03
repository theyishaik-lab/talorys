package com.talorys.keyboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.core.widget.doAfterTextChanged
import com.talorys.keyboard.databinding.TkActivityChatBinding
import com.talorys.keyboard.databinding.TkItemMessageAgentBinding
import com.talorys.keyboard.databinding.TkItemMessageUserBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Talorys chat sheet: a dimmed, translucent window with a bottom sheet holding the conversation,
 * a composer, a loading state, and per-reply Copy / Insert-into-field actions.
 *
 * Opened from the keyboard's Ask button (with insert target), and reused by [AssistActivity].
 * Nothing is sent until the user taps Send. The screen context (app + field hint) is shown as a
 * chip and can be removed before sending.
 */
open class ChatActivity : AppCompatActivity() {

    private lateinit var binding: TkActivityChatBinding
    private lateinit var client: AgentClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var inFlight: Job? = null

    private var screenContext: String? = null
    private var targetPackage: String? = null
    private var targetFieldId: Int = 0
    /** The agent conversation this sheet continues; follow-ups go to the same one until the sheet closes. */
    private var conversationId: String? = null

    /** Context to show/send. Subclasses (assistant) derive it from their own intent extras. */
    protected open fun readScreenContext(intent: Intent): String? = intent.getStringExtra(EXTRA_CONTEXT)

    /** Text to pre-fill the composer with (never auto-sent). */
    protected open fun readPrefill(intent: Intent): String? = intent.getStringExtra(EXTRA_PREFILL)

    override fun onCreate(savedInstanceState: Bundle?) {
        // Material You colours on Android 12+ (the app's Application class is React Native's, so per activity).
        com.google.android.material.color.DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        binding = TkActivityChatBinding.inflate(layoutInflater)
        setContentView(binding.root)
        client = AgentClient.get(this)

        applyInsets()
        binding.scrim.setOnClickListener { finish() }
        binding.btnClose.setOnClickListener { finish() }
        binding.btnOpenSettings.setOnClickListener {
            // Signing in happens in the Talorys app; the keyboard shares its session.
            AppLink.open(this)
            finish()
        }
        binding.btnSend.setOnClickListener { send() }
        binding.etMessage.doAfterTextChanged { updateSendEnabled() }
        binding.chipContext.setOnCloseIconClickListener {
            screenContext = null
            binding.chipContext.isVisible = false
            Toast.makeText(this, R.string.tk_chat_context_removed, Toast.LENGTH_SHORT).show()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finish()
        })

        readIntent(intent)
        renderConfigState()
        binding.etMessage.requestFocus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readIntent(intent)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun readIntent(intent: Intent) {
        screenContext = readScreenContext(intent)?.take(MAX_CONTEXT_CHARS)
        targetPackage = intent.getStringExtra(EXTRA_TARGET_PACKAGE)
        targetFieldId = intent.getIntExtra(EXTRA_TARGET_FIELD, 0)
        binding.chipContext.isVisible = !screenContext.isNullOrBlank()
        binding.chipContext.text = getString(R.string.tk_chat_context_chip, screenContext.orEmpty())
        readPrefill(intent)?.takeIf { it.isNotBlank() }?.let {
            binding.etMessage.setText(it.take(MAX_MESSAGE_CHARS))
            binding.etMessage.setSelection(binding.etMessage.length())
        }
    }

    private fun renderConfigState() {
        val configured = client.isConfigured
        binding.btnOpenSettings.isVisible = !configured
        binding.emptyBody.setText(if (configured) R.string.tk_chat_empty_body else R.string.tk_chat_not_configured)
        binding.tilMessage.isEnabled = configured
        updateSendEnabled()
    }

    private fun updateSendEnabled() {
        binding.btnSend.isEnabled = client.isConfigured && inFlight?.isActive != true &&
            !binding.etMessage.text.isNullOrBlank()
    }

    /** Edge-to-edge: keep the sheet below the status bar and the composer above the IME / nav bar. */
    private fun applyInsets() {
        val topMargin = (binding.sheet.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.topMargin ?: 0
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            binding.sheet.updateLayoutParams<android.view.ViewGroup.MarginLayoutParams> {
                this.topMargin = topMargin + bars.top
                leftMargin = bars.left
                rightMargin = bars.right
            }
            binding.sheetContent.updatePadding(bottom = maxOf(ime.bottom, bars.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun send() {
        val text = binding.etMessage.text?.toString()?.trim().orEmpty()
        if (text.isEmpty() || !client.isConfigured || inFlight?.isActive == true) return
        binding.etMessage.setText("")
        binding.emptyState.isVisible = false
        addUserBubble(text)
        val reply = addAgentBubble()
        ask(text, screenContext, reply)
    }

    private fun ask(text: String, context: String?, reply: TkItemMessageAgentBinding) {
        reply.text.setText(R.string.tk_chat_thinking)
        reply.text.alpha = 0.6f
        reply.actions.isVisible = false
        setLoading(true)
        inFlight = scope.launch {
            val result = runCatching { client.chat(text, context, conversationId) }
            setLoading(false)
            reply.text.alpha = 1f
            result.onSuccess { resp ->
                resp.conversation_id?.let { conversationId = it }
                if (resp.reply.isBlank()) showError(reply, getString(R.string.tk_chat_empty_reply), text, context)
                else showReply(reply, resp.reply)
            }.onFailure { e ->
                val err = (e as? AgentException)?.chatError
                if (err != null) showError(reply, describe(err), text, context, reloginHint = err.kind == ChatError.Kind.AUTH_EXPIRED)
                else showError(reply, getString(R.string.tk_chat_error, e.message ?: e.javaClass.simpleName), text, context)
            }
            scrollToBottom()
        }
    }

    private fun showReply(b: TkItemMessageAgentBinding, reply: String) {
        b.text.text = reply
        b.bubble.setCardBackgroundColor(resolveColor(com.google.android.material.R.attr.colorSurfaceContainerHighest))
        b.actions.isVisible = true
        b.btnRetry.isVisible = false
        b.btnCopy.isVisible = true
        b.btnCopy.setOnClickListener { copy(reply) }
        val canInsert = targetPackage != null && targetPackage != packageName
        b.btnInsert.isVisible = canInsert
        b.btnInsert.setOnClickListener { insert(reply) }
    }

    /** The user-facing text for a failed Ask: what happened, the HTTP status, and the agent's reason. */
    private fun describe(e: ChatError): String {
        val reason = e.reason?.takeIf { it.isNotBlank() } ?: e.summary().ifBlank { e.kind.name }
        val main = when (e.kind) {
            ChatError.Kind.AUTH_EXPIRED -> getString(R.string.tk_chat_error_auth)
            ChatError.Kind.FORBIDDEN -> getString(R.string.tk_chat_error_forbidden, reason)
            ChatError.Kind.NOT_FOUND -> getString(R.string.tk_chat_error_not_found)
            ChatError.Kind.BUSY -> getString(R.string.tk_chat_error_busy)
            ChatError.Kind.LIMIT -> getString(R.string.tk_chat_error_limit, reason)
            ChatError.Kind.MODELS_FAILED -> getString(R.string.tk_chat_error_models, e.httpCode, reason)
            ChatError.Kind.HTTP -> getString(R.string.tk_chat_error_http, e.summary())
            ChatError.Kind.EMPTY -> getString(R.string.tk_chat_error_empty)
            ChatError.Kind.TIMEOUT -> getString(R.string.tk_chat_error_timeout, reason)
            ChatError.Kind.NETWORK -> getString(R.string.tk_chat_error_network, reason)
            ChatError.Kind.BAD_RESPONSE -> getString(R.string.tk_chat_error_bad_response, reason)
        }
        return if (e.attempts.isNullOrBlank()) main else main + "\n\n" + getString(R.string.tk_chat_error_attempts, e.attempts)
    }

    private fun showError(b: TkItemMessageAgentBinding, message: String, text: String, context: String?, reloginHint: Boolean = false) {
        b.text.text = message
        b.bubble.setCardBackgroundColor(resolveColor(com.google.android.material.R.attr.colorErrorContainer))
        b.actions.isVisible = true
        b.btnCopy.isVisible = false
        b.btnInsert.isVisible = false
        b.btnRetry.isVisible = true
        if (reloginHint) {
            // A new token is needed; retrying with the expired one can't work.
            b.btnRetry.setText(R.string.tk_chat_open_settings)
            b.btnRetry.setOnClickListener {
                AppLink.open(this)
                finish()
            }
        } else {
            b.btnRetry.setText(R.string.tk_chat_retry)
            b.btnRetry.setOnClickListener { if (inFlight?.isActive != true) ask(text, context, b) }
        }
    }

    private fun setLoading(loading: Boolean) {
        binding.progress.visibility = if (loading) View.VISIBLE else View.INVISIBLE
        updateSendEnabled()
    }

    private fun addUserBubble(text: String) {
        val b = TkItemMessageUserBinding.inflate(LayoutInflater.from(this), binding.messages, false)
        b.text.text = text
        b.root.contentDescription = getString(R.string.tk_chat_you) + ": " + text
        binding.messages.addView(b.root)
        scrollToBottom()
    }

    private fun addAgentBubble(): TkItemMessageAgentBinding {
        val b = TkItemMessageAgentBinding.inflate(LayoutInflater.from(this), binding.messages, false)
        binding.messages.addView(b.root)
        scrollToBottom()
        return b
    }

    private fun scrollToBottom() {
        binding.messagesScroll.post { binding.messagesScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun copy(text: String) {
        val cm = getSystemService(ClipboardManager::class.java)
        cm.setPrimaryClip(ClipData.newPlainText(getString(R.string.tk_chat_title), text))
        // Android 13+ shows its own clipboard confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(this, R.string.tk_chat_copied, Toast.LENGTH_SHORT).show()
        }
    }

    private fun insert(text: String) {
        val pkg = targetPackage ?: return
        PendingInsert.set(text, pkg, targetFieldId)
        Toast.makeText(this, R.string.tk_chat_insert_ready, Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun resolveColor(attr: Int): Int {
        val tv = android.util.TypedValue()
        theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) getColor(tv.resourceId) else tv.data
    }

    companion object {
        const val EXTRA_CONTEXT = "com.talorys.keyboard.extra.CONTEXT"
        const val EXTRA_PREFILL = "com.talorys.keyboard.extra.PREFILL"
        const val EXTRA_TARGET_PACKAGE = "com.talorys.keyboard.extra.TARGET_PACKAGE"
        const val EXTRA_TARGET_FIELD = "com.talorys.keyboard.extra.TARGET_FIELD"

        fun intent(
            context: Context,
            screenContext: String? = null,
            prefill: String? = null,
            targetPackage: String? = null,
            targetFieldId: Int = 0,
        ): Intent = Intent(context, ChatActivity::class.java)
            .putExtra(EXTRA_CONTEXT, screenContext)
            .putExtra(EXTRA_PREFILL, prefill)
            .putExtra(EXTRA_TARGET_PACKAGE, targetPackage)
            .putExtra(EXTRA_TARGET_FIELD, targetFieldId)
    }
}
