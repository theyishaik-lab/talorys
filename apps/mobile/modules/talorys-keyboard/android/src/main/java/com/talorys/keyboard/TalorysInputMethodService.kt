package com.talorys.keyboard

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputMethodSubtype
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.color.DynamicColors
import com.talorys.keyboard.clip.ClipItem
import com.talorys.keyboard.clip.ClipboardHistory
import com.talorys.keyboard.keyboard.Codes
import com.talorys.keyboard.keyboard.Feedback
import com.talorys.keyboard.keyboard.FieldFlavor
import com.talorys.keyboard.keyboard.FieldPolicy
import com.talorys.keyboard.keyboard.Geometry
import com.talorys.keyboard.keyboard.Key
import com.talorys.keyboard.keyboard.KeyPreviewView
import com.talorys.keyboard.keyboard.KeyboardView
import com.talorys.keyboard.keyboard.Language
import com.talorys.keyboard.keyboard.Layouts
import com.talorys.keyboard.keyboard.Mode
import com.talorys.keyboard.keyboard.ShiftState
import com.talorys.keyboard.keyboard.SuggestionStripView
import com.talorys.keyboard.keyboard.SuggestionStripView.Slot
import com.talorys.keyboard.keyboard.SuggestionStripView.Tool
import com.talorys.keyboard.suggest.Bigrams
import com.talorys.keyboard.suggest.EmojiSuggestions
import com.talorys.keyboard.suggest.KeyProximity
import com.talorys.keyboard.suggest.LanguageModel
import com.talorys.keyboard.suggest.LatestRunner
import com.talorys.keyboard.suggest.LruCache
import com.talorys.keyboard.suggest.Pt
import com.talorys.keyboard.suggest.Suggester
import com.talorys.keyboard.suggest.SwipeDecoder
import com.talorys.keyboard.suggest.UserDictionary
import com.talorys.keyboard.suggest.WordDictionary
import com.talorys.keyboard.suggest.WordLogic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

private const val TAG = "TalorysIME"

/**
 * The Talorys keyboard. An Android IME *replaces* the system keyboard, so this provides a complete
 * Gboard-style keyboard (English QWERTY + Hebrew with a number row, long-press popups, symbols,
 * emoji, number/phone pads), glide typing, word suggestions / autocorrect / prediction from
 * bundled offline dictionaries, a clipboard history, and a strip on top that is a toolbar
 * (clipboard, emoji, Ask Talorys, one-handed, settings, Talorys panel) when idle and a
 * three-slot suggestion strip while typing.
 *
 * Threading: every word-engine computation (suggestions, autocorrect candidates, next-letter
 * probabilities for the hit boxes, glide decoding) runs on one background thread through a
 * "latest request wins" runner; the main thread only reads the text around the cursor, commits
 * text and draws. Key-down feedback (haptic, sound, pressed key) happens before anything else.
 *
 * Privacy: suggestions, autocorrect and gesture decoding run on-device. Typed text reaches the agent
 * only when the user taps Send in the chat sheet. The personal dictionary (learned words and word
 * pairs, never from password / email / URL fields or apps that ask for no learning) is stored
 * locally and, only if "Backup to Talorys cloud" is on and the user's own agent is configured,
 * backed up to that agent. The clipboard history stays on the phone, encrypted, and skips clips
 * marked sensitive and anything copied in a password field.
 */
class TalorysInputMethodService : InputMethodService(), KeyboardView.Listener {

    private lateinit var prefs: UiPrefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())
    /** The word engine's single background thread. */
    private val engineExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "talorys-engine").apply { priority = Thread.NORM_PRIORITY + 1; isDaemon = true }
    }
    private val engine = engineExecutor.asCoroutineDispatcher()
    private val stripRunner = LatestRunner(scope, engine, debounceMs = STRIP_DEBOUNCE_MS)

    private var companion: CompanionService? = null
    private var bound = false
    private var suggestionsJob: Job? = null

    private var root: View? = null
    private var keyboard: KeyboardView? = null
    private var preview: KeyPreviewView? = null
    private var strip: SuggestionStripView? = null
    private var panel: View? = null
    private var panelChips: ChipGroup? = null
    private var panelEmpty: View? = null
    private var panelTitle: View? = null
    private var btnAsk: MaterialButton? = null
    private var chipSetup: Chip? = null
    private var clipPanel: View? = null
    private var clipList: LinearLayout? = null
    private var clipEmpty: TextView? = null
    private enum class Panel { NONE, TALORYS, CLIPBOARD }
    private var openPanel = Panel.NONE
    private var builtThemeKey: String? = null
    private var builtNight = false

    private lateinit var feedback: Feedback
    private lateinit var clipboard: ClipboardHistory
    private var clipChip: ClipItem? = null
    private var clipChipAt = 0L

    private var language = Language.EN
    private var mode = Mode.ALPHA
    private var flavor = FieldFlavor.TEXT
    private var shift = ShiftState.OFF
    private var emojiPage = 0
    private var lastShiftTap = 0L
    private var lastSpaceTap = 0L
    private var forceLatin = false
    private var isPasswordField = false
    private var isOwnField = false
    private var autoCapEnabled = false
    private var latestSuggestions: List<Suggestion> = emptyList()
    /** The user opened the toolbar while typing; shown until the next key. */
    private var toolbarRequested = false

    // ---- cursor / selection tracking ----
    private var selStart = -1
    private var selEnd = -1
    /** Backspace swipe: the cursor position when it started (or -1). */
    private var deleteAnchor = -1
    private var deleteBefore: CharSequence? = null

    // ---- word engine state ----
    private val dictionaries = HashMap<Language, WordDictionary>()
    private val models = HashMap<Language, LanguageModel>()
    private val suggesters = HashMap<Language, Suggester>()
    private val proximities = HashMap<Language, KeyProximity>()
    private lateinit var learned: UserDictionary
    /** The last autocorrection, while backspace can still revert it. */
    private data class AutoCorrection(val original: String, val corrected: String, val separator: String)
    private var lastAutocorrect: AutoCorrection? = null
    private var fieldPolicy = FieldPolicy.of(InputType.TYPE_CLASS_TEXT, 0)
    private val analysisCache = LruCache<String, Suggester.Analysis>(48)
    /** Where each letter of the word in progress was tapped (key units), for the spatial model. */
    private val touches = ArrayList<Pt?>()
    /** The last glided word and its alternatives, while the cursor still sits right after it. */
    private data class SwipeState(val word: String, val alternatives: List<String>)
    private var lastSwipe: SwipeState? = null
    /** After a glide, the next tapped letter or glide gets a space first (Gboard's "phantom space"). */
    private var pendingSpace = false
    /** A glide is being decoded; keys typed meanwhile wait in [pendingInput]. */
    private var gestureJob: Job? = null
    private val pendingInput = ArrayList<() -> Unit>()
    private val refreshRunnable = Runnable { refreshSuggestions() }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as? CompanionService.LocalBinder)?.service ?: return
            companion = svc
            suggestionsJob?.cancel()
            suggestionsJob = svc.suggestions.onEach { latestSuggestions = it; updateAgentUi() }.launchIn(scope)
            svc.setKeyboardVisible(isInputViewShown)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            suggestionsJob?.cancel()
            companion = null
        }
    }

    override fun onCreate() {
        super.onCreate()
        prefs = UiPrefs(this)
        feedback = Feedback(this)
        learned = LearnedWords.get(this)
        clipboard = ClipboardHistory.get(this).also { c ->
            c.passwordFieldFocused = { isPasswordField }
            c.onNewClip = { item ->
                if (!isPasswordField) { clipChip = item; clipChipAt = SystemClock.uptimeMillis() }
                if (openPanel == Panel.CLIPBOARD) renderClipboard()
                scheduleRefresh()
            }
        }
        applyPrefs()
        clipboard.startListening()
        language = when {
            prefs.language.isNotEmpty() -> Language.fromTag(prefs.language)
            else -> runCatching {
                getSystemService(InputMethodManager::class.java).currentInputMethodSubtype?.let { subtypeLanguage(it) }
            }.getOrNull() ?: Language.EN
        }
        // Plain bind (no startService): works from the background on every API level.
        bound = runCatching {
            bindService(Intent(this, CompanionService::class.java), connection, Context.BIND_AUTO_CREATE)
        }.onFailure { Log.w(TAG, "bind CompanionService failed", it) }.getOrDefault(false)
        loadDictionaries()
    }

    /** Re-reads the settings that can change while the keyboard service lives. */
    private fun applyPrefs() {
        feedback.strength = prefs.hapticStrength
        feedback.useSystem = prefs.hapticSystem
        feedback.sound = prefs.sound
        feedback.soundVolume = prefs.soundVolume
        clipboard.configure(prefs.clipboardHistory, prefs.clipboardExpiryMs)
    }

    private fun loadDictionaries() {
        scope.launch {
            for (lang in Language.entries) {
                val loaded = withContext(engine) {
                    runCatching {
                        val dict = assets.open("dict/${lang.tag}.txt").reader(Charsets.UTF_8).use { WordDictionary.load(it) }
                        val pairs = runCatching {
                            assets.open("dict/${lang.tag}.bigrams.txt").reader(Charsets.UTF_8).use { Bigrams.load(it) }
                        }.onFailure { Log.w(TAG, "bigrams ${lang.tag} failed to load", it) }.getOrDefault(Bigrams.EMPTY)
                        val model = LanguageModel(dict, pairs, learned, lang.tag, com.talorys.keyboard.screen.ScreenWordLearner.store(this@TalorysInputMethodService))
                        val prox = proximity(lang)
                        val s = Suggester(model, prox)
                        s.nextChars("", null) // warm the first-letter table off the main thread
                        Triple(dict, model, s) to prox
                    }.onFailure { Log.w(TAG, "dictionary ${lang.tag} failed to load", it) }.getOrNull()
                }
                if (loaded != null) {
                    dictionaries[lang] = loaded.first.first
                    models[lang] = loaded.first.second
                    suggesters[lang] = loaded.first.third
                    proximities[lang] = loaded.second
                }
            }
            // Screen-learned words skip built-in words; drop any recorded before the dictionaries were loaded.
            val screenStore = com.talorys.keyboard.screen.ScreenWordLearner.store(this@TalorysInputMethodService)
            val dicts = dictionaries.toMap()
            screenStore.isMainWord = { tag, w -> dicts[Language.fromTag(tag)]?.contains(w) == true }
            withContext(engine) { if (screenStore.pruneKnown() > 0) screenStore.flush() }
            scheduleRefresh()
        }
    }

    /** Key positions of the letter layout at a nominal size, for typo costs (independent of the view). */
    private fun proximity(lang: Language): KeyProximity {
        val rows = if (lang == Language.HE) Layouts.hebrew(FieldFlavor.TEXT, true) else Layouts.english(FieldFlavor.TEXT, true)
        val placed = Geometry.layout(rows, 0f, 0f, KeyboardView.NOMINAL_W, KeyboardView.NOMINAL_H).filter { it.first.isLetter }
        return KeyProximity(placed.associate { it.first.label[0] to Pt(it.second.centerX, it.second.centerY) }, placed.first().second.width)
    }

    override fun onDestroy() {
        Thread { learned.flush(); com.talorys.keyboard.screen.ScreenWordLearner.store(this).flush() }.start()
        clipboard.stopListening()
        clipboard.onNewClip = null
        scope.cancel()
        engineExecutor.shutdown()
        mainHandler.removeCallbacksAndMessages(null)
        if (bound) {
            runCatching { unbindService(connection) }
            bound = false
        }
        super.onDestroy()
    }

    override fun onEvaluateFullscreenMode(): Boolean = false

    /**
     * The input view is wrap_content and sits at the bottom of the IME window. Report its top as
     * both content and visible top, so the app is laid out (and visible) above the keyboard and
     * touches above it go to the app.
     */
    override fun onComputeInsets(outInsets: InputMethodService.Insets) {
        super.onComputeInsets(outInsets)
        val v = root ?: return
        if (!v.isShown || v.height <= 0) return
        val decor = window?.window?.decorView ?: return
        val loc = IntArray(2)
        v.getLocationInWindow(loc)
        val top = loc[1].coerceIn(0, decor.height)
        outInsets.contentTopInsets = top
        outInsets.visibleTopInsets = top
        outInsets.touchableInsets = InputMethodService.Insets.TOUCHABLE_INSETS_VISIBLE
        outInsets.touchableRegion.setEmpty()
    }

    private fun systemNight(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** The keyboard's themed context: light / dark / follow the system, Material You colours on Android 12+ when enabled. */
    private fun themedContext(): Context {
        val night = when (prefs.theme) { "light" -> false; "dark" -> true; else -> systemNight() }
        val cfg = Configuration(resources.configuration)
        cfg.uiMode = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        val base = createConfigurationContext(cfg)
        val dynamic = prefs.dynamicColor && DynamicColors.isDynamicColorAvailable()
        val themed = ContextThemeWrapper(base, if (dynamic) R.style.Theme_Talorys_Keyboard_Dynamic else R.style.Theme_Talorys_Keyboard)
        builtThemeKey = prefs.themeKey
        builtNight = systemNight()
        return if (dynamic) DynamicColors.wrapContextIfAvailable(themed) else themed
    }

    @android.annotation.SuppressLint("InflateParams") // IME input views have no parent at inflation
    override fun onCreateInputView(): View {
        // IME windows default to a framework theme; Material widgets need our Material3 theme.
        val themed = themedContext()
        val view = LayoutInflater.from(themed).inflate(R.layout.tk_keyboard_input_view, null, false)
        root = view
        preview = view.findViewById(R.id.key_preview)
        keyboard = view.findViewById<KeyboardView>(R.id.keyboard).also { kb ->
            kb.listener = this
            kb.previewListener = object : KeyboardView.PreviewListener {
                override fun onPreview(label: String?, keyRect: RectF?) = showPreview(label, keyRect)
                override fun onPopup(options: List<String>?, rects: List<RectF>?, selected: Int) = showPopup(options, rects, selected)
            }
        }
        strip = view.findViewById<SuggestionStripView>(R.id.strip).apply {
            onMic = { startVoiceTyping() }
            onExpandToolbar = { toolbarRequested = true; refreshSuggestions() }
            micDescription = getString(R.string.tk_strip_voice)
            expandDescription = getString(R.string.tk_strip_toolbar)
        }
        panel = view.findViewById(R.id.talorys_panel)
        panelChips = view.findViewById(R.id.panel_chips)
        panelEmpty = view.findViewById(R.id.panel_empty)
        panelTitle = view.findViewById(R.id.panel_suggestions_title)
        btnAsk = view.findViewById<MaterialButton>(R.id.btn_ask).apply { setOnClickListener { openChat() } }
        chipSetup = view.findViewById<Chip>(R.id.chip_setup).apply { setOnClickListener { openSettings() } }
        view.findViewById<View>(R.id.btn_settings).setOnClickListener { openSettings() }
        view.findViewById<View>(R.id.btn_hide).setOnClickListener { requestHideSelf(0) }
        view.findViewById<View>(R.id.btn_back).setOnClickListener { setPanel(Panel.NONE) }
        clipPanel = view.findViewById(R.id.clip_panel)
        clipList = view.findViewById(R.id.clip_list)
        clipEmpty = view.findViewById(R.id.clip_empty)
        view.findViewById<View>(R.id.clip_close).setOnClickListener { setPanel(Panel.NONE) }
        view.findViewById<View>(R.id.clip_clear).setOnClickListener {
            clipboard.store.clear(includePinned = false)
            clipboard.persist()
            clipChip = null
            renderClipboard()
        }
        val iconTint = ColorStateList.valueOf(themeColor(themed, R.attr.kbKeyText))
        view.findViewById<ImageButton>(R.id.clip_close).imageTintList = iconTint
        view.findViewById<ImageButton>(R.id.clip_clear).imageTintList = iconTint

        // Keep keys above the gesture / 3-button navigation bar on edge-to-edge devices.
        val basePadding = keyboard!!.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(view) { _, insets ->
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            keyboard?.updatePadding(bottom = basePadding + nav.bottom)
            panel?.updatePadding(bottom = nav.bottom)
            clipPanel?.updatePadding(bottom = nav.bottom)
            insets
        }
        openPanel = Panel.NONE
        applyKeyboard()
        updateAgentUi()
        return view
    }

    override fun onStartInput(attribute: EditorInfo, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        selStart = attribute.initialSelStart
        selEnd = attribute.initialSelEnd
        // Deliver text the user chose to insert from the chat sheet into the field it was meant for.
        PendingInsert.take(attribute.packageName, attribute.fieldId)?.let { text ->
            currentInputConnection?.commitText(text, 1)
        }
    }

    override fun onStartInputView(info: EditorInfo, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        applyPrefs()
        // Theme changed in Settings, or the system switched light / dark: rebuild the view.
        if (root != null && (builtThemeKey != prefs.themeKey || (prefs.theme == "system" && builtNight != systemNight()))) {
            setInputView(onCreateInputView())
        }
        configureForField(info)
        lastSwipe = null
        pendingSpace = false
        touches.clear()
        toolbarRequested = false
        deleteAnchor = -1
        if (!restarting) setPanel(Panel.NONE)
        applyKeyboard()
        updateAutoCaps()
        updateAgentUi()
        scheduleRefresh()
        companion?.setKeyboardVisible(true)
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        super.onFinishInputView(finishingInput)
        keyboard?.cancelTouches()
        preview?.show(null, null)
        preview?.showPopup(null, null, -1)
        setPanel(Panel.NONE)
        stripRunner.cancel()
        companion?.setKeyboardVisible(false)
        lastAutocorrect = null
        // Persist what was learned and, if enabled, back it up (debounced, needs network).
        scope.launch(Dispatchers.IO) {
            learned.flush()
            com.talorys.keyboard.screen.ScreenWordLearner.store(this@TalorysInputMethodService).flush()
            DictionarySync.maybeSchedule(this@TalorysInputMethodService)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyKeyHeight()
    }

    override fun onCurrentInputMethodSubtypeChanged(newSubtype: InputMethodSubtype) {
        super.onCurrentInputMethodSubtypeChanged(newSubtype)
        subtypeLanguage(newSubtype)?.let { setLanguage(it) }
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        selStart = newSelStart
        selEnd = newSelEnd
        // The cursor jumped (tap in the text, cursor slide): the touches no longer match a word.
        if (newSelStart != newSelEnd || kotlin.math.abs(newSelStart - oldSelStart) > 1) touches.clear()
        updateAutoCaps()
        scheduleRefresh()
    }

    // ---- field configuration ----

    private fun configureForField(info: EditorInfo) {
        val cls = info.inputType and InputType.TYPE_MASK_CLASS
        val variation = info.inputType and InputType.TYPE_MASK_VARIATION
        isOwnField = info.packageName == packageName
        fieldPolicy = FieldPolicy.of(info.inputType, info.imeOptions)
        lastAutocorrect = null
        isPasswordField = fieldPolicy.password
        flavor = when {
            cls == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS) -> FieldFlavor.EMAIL
            cls == InputType.TYPE_CLASS_TEXT && variation == InputType.TYPE_TEXT_VARIATION_URI -> FieldFlavor.URI
            else -> FieldFlavor.TEXT
        }
        // Emails, URLs and passwords are Latin; don't change the user's saved language for them.
        forceLatin = flavor != FieldFlavor.TEXT || isPasswordField
        mode = when (cls) {
            InputType.TYPE_CLASS_NUMBER, InputType.TYPE_CLASS_DATETIME -> Mode.NUMBER
            InputType.TYPE_CLASS_PHONE -> Mode.PHONE
            else -> Mode.ALPHA
        }
        autoCapEnabled = cls == InputType.TYPE_CLASS_TEXT && !isPasswordField &&
            (info.inputType and (InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)) != 0
        shift = ShiftState.OFF
        if (isPasswordField) clipChip = null
        updateEnterKey(info)
    }

    private val effectiveLanguage: Language get() = if (forceLatin) Language.EN else language

    /** Word features (glide, completions) only for ordinary text, never passwords / emails / URLs. */
    private val wordFeaturesAllowed: Boolean get() = !forceLatin && !isPasswordField

    /** Learning: ordinary text only, never passwords / emails / URLs or apps asking for no personalised learning. */
    private val learningAllowed: Boolean get() = wordFeaturesAllowed && fieldPolicy.learning && mode != Mode.NUMBER && mode != Mode.PHONE

    /** Autocorrect: the setting, ordinary text fields only (never URL / email / password fields). */
    private val autocorrectAllowed: Boolean
        get() = wordFeaturesAllowed && fieldPolicy.autocorrect(prefs.autocorrect) && mode != Mode.NUMBER && mode != Mode.PHONE

    private fun applyKeyHeight() {
        val kb = keyboard ?: return
        val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val dp = prefs.keyHeightDp * if (landscape) UiPrefs.LANDSCAPE_SCALE else 1f
        kb.rowHeight = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics)
    }

    private fun applyKeyboard() {
        val kb = keyboard ?: return
        applyKeyHeight()
        // The "back to letters" key names the alphabet it returns to.
        val abc = if (effectiveLanguage == Language.HE) "אבג" else "ABC"
        kb.setKeys(Layouts.build(mode, effectiveLanguage, flavor, abc, showLang = !forceLatin, emojiPage = emojiPage))
        kb.spaceLabel = getString(if (effectiveLanguage == Language.HE) R.string.tk_lang_he_space else R.string.tk_lang_en_space)
        kb.langLabel = getString(if (effectiveLanguage == Language.HE) R.string.tk_lang_he_short else R.string.tk_lang_en_short)
        kb.hintsOnLeft = effectiveLanguage == Language.HE && mode == Mode.ALPHA
        kb.gestureEnabled = prefs.swipe && mode == Mode.ALPHA && wordFeaturesAllowed
        kb.previewsEnabled = prefs.keyPreviews
        kb.showHints = prefs.showHints
        kb.oneHanded = if (mode == Mode.EMOJI) 0 else prefs.oneHanded
        if (mode != Mode.ALPHA || !wordFeaturesAllowed) kb.nextCharProbs = null
        strip?.micVisible = !isPasswordField
        strip?.rtl = effectiveLanguage == Language.HE
        applyShift()
        currentInputEditorInfo?.let { updateEnterKey(it) }
    }

    private fun applyShift() {
        val kb = keyboard ?: return
        val letters = mode == Mode.ALPHA && effectiveLanguage == Language.EN
        kb.shiftState = shift
        kb.uppercaseLabels = letters && shift != ShiftState.OFF
    }

    private fun updateEnterKey(info: EditorInfo) {
        val kb = keyboard ?: return
        val action = info.imeOptions and EditorInfo.IME_MASK_ACTION
        val noAction = (info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
        val (icon, desc) = if (noAction) R.drawable.tk_ic_enter to R.string.tk_key_enter else when (action) {
            EditorInfo.IME_ACTION_SEARCH -> R.drawable.tk_ic_search to R.string.tk_key_label_go
            EditorInfo.IME_ACTION_SEND -> R.drawable.tk_ic_send to R.string.tk_key_label_send
            EditorInfo.IME_ACTION_GO -> R.drawable.tk_ic_arrow_forward to R.string.tk_key_label_go
            EditorInfo.IME_ACTION_NEXT -> R.drawable.tk_ic_arrow_forward to R.string.tk_key_label_next
            EditorInfo.IME_ACTION_PREVIOUS -> R.drawable.tk_ic_arrow_forward to R.string.tk_key_label_prev
            EditorInfo.IME_ACTION_DONE -> R.drawable.tk_ic_check to R.string.tk_key_label_done
            else -> R.drawable.tk_ic_enter to R.string.tk_key_enter
        }
        kb.setEnterAppearance(icon, info.actionLabel?.toString() ?: getString(desc))
    }

    private fun updateAutoCaps() {
        if (shift == ShiftState.LOCKED) return
        val want = if (autoCapEnabled && mode == Mode.ALPHA && effectiveLanguage == Language.EN) {
            val info = currentInputEditorInfo
            val ic = currentInputConnection
            info != null && ic != null && ic.getCursorCapsMode(info.inputType) != 0 && !pendingSpace
        } else false
        val newState = if (want) ShiftState.ON else ShiftState.OFF
        if (newState != shift) { shift = newState; applyShift() }
    }

    // ---- KeyboardView.Listener ----

    override fun onKeyDown(key: Key) {
        // Instant feedback on touch-down, before any text work.
        keyboard?.let { feedback.keyDown(it, key.code) }
    }

    /** While a glide is still being decoded, input waits so the order of words is kept. */
    private fun deferred(action: () -> Unit): Boolean {
        if (gestureJob?.isActive != true) return false
        pendingInput += action
        return true
    }

    override fun onKey(key: Key, touch: Pt?) {
        if (deferred { onKey(key, touch) }) return
        val ic = currentInputConnection ?: return
        if (key.code != Codes.DELETE && key.code != Codes.SHIFT) lastAutocorrect = null
        if (key.code != Codes.SHIFT) toolbarRequested = false
        when (key.code) {
            Codes.CHAR -> typeText(key.output, touch)
            Codes.SPACE -> { val afterSwipe = lastSwipe != null; pendingSpace = false; lastSwipe = null; touches.clear(); onSpace(afterSwipe) }
            Codes.DELETE -> onDelete()
            Codes.DELETE_WORD -> deleteWords(1)
            Codes.ENTER -> {
                val afterSwipe = lastSwipe != null
                pendingSpace = false; lastSwipe = null
                onWordBoundary("\n", fromSwipe = afterSwipe, correct = false)
                touches.clear()
                onEnter()
            }
            Codes.SHIFT -> onShift()
            Codes.SYMBOLS -> setMode(Mode.SYMBOLS)
            Codes.SYMBOLS_MORE -> setMode(if (mode == Mode.SYMBOLS_MORE) Mode.SYMBOLS else Mode.SYMBOLS_MORE)
            Codes.ALPHA -> setMode(Mode.ALPHA)
            Codes.EMOJI -> setMode(Mode.EMOJI)
            Codes.EMOJI_PREV -> { emojiPage = (emojiPage - 1).mod(Layouts.emojiPageCount); applyKeyboard() }
            Codes.EMOJI_NEXT -> { emojiPage = (emojiPage + 1).mod(Layouts.emojiPageCount); applyKeyboard() }
            Codes.LANG -> setLanguage(if (language == Language.EN) Language.HE else Language.EN)
            Codes.ONE_HAND_SWITCH -> setOneHanded(if (prefs.oneHanded < 0) 1 else -1)
            Codes.ONE_HAND_EXIT -> setOneHanded(0)
        }
        if (ic === currentInputConnection) scheduleRefresh()
    }

    /** Types a character key's text (or a popup choice): phantom space, word boundary, case. */
    private fun typeText(raw: String, touch: Pt?) {
        val ic = currentInputConnection ?: return
        val out = if (shift != ShiftState.OFF && mode == Mode.ALPHA && effectiveLanguage == Language.EN) raw.uppercase() else raw
        if (pendingSpace && out.firstOrNull()?.isLetterOrDigit() == true) ic.commitText(" ", 1)
        val afterSwipe = lastSwipe != null
        pendingSpace = false
        lastSwipe = null
        val separator = out != "'" && WordLogic.isWordSeparator(out)
        if (separator) {
            onWordBoundary(out, fromSwipe = afterSwipe, correct = true)
            touches.clear()
        } else if (out.length == 1 && (Character.isLetterOrDigit(out[0]) || out[0] == '\'')) {
            if (afterSwipe) touches.clear()
            touches += touch
        } else {
            touches.clear()
        }
        ic.commitText(out, 1)
        if (shift == ShiftState.ON) { shift = ShiftState.OFF; applyShift() }
        lastSpaceTap = 0
    }

    override fun onText(text: String) {
        if (deferred { onText(text) }) return
        lastAutocorrect = null
        typeText(text, null)
        scheduleRefresh()
    }

    override fun onLongPress(key: Key): Boolean {
        return when {
            key.longPressCode != null -> {
                onKey(Key(key.longPressCode), null)
                true
            }
            key.code == Codes.LANG || key.code == Codes.SPACE -> {
                runCatching { getSystemService(InputMethodManager::class.java).showInputMethodPicker() }
                true
            }
            key.longPress != null -> {
                onText(key.longPress)
                true
            }
            else -> false
        }
    }

    override fun onCursorMove(steps: Int) {
        val ic = currentInputConnection ?: return
        if (steps == 0) return
        val code = if (steps > 0) KeyEvent.KEYCODE_DPAD_RIGHT else KeyEvent.KEYCODE_DPAD_LEFT
        repeat(kotlin.math.abs(steps)) { sendDownUpKeyEvents(code) }
        keyboard?.let { feedback.tick(it) }
        lastSwipe = null; pendingSpace = false; lastAutocorrect = null; touches.clear()
        scheduleRefresh()
    }

    override fun onDeleteSwipe(words: Int, done: Boolean) {
        val ic = currentInputConnection ?: return
        if (deleteAnchor < 0) {
            if (words == 0) return
            // Start: remember the cursor and the text before it (selections are measured from here).
            deleteAnchor = if (selStart >= 0) selStart else return
            deleteBefore = ic.getTextBeforeCursor(MAX_DELETE_LOOKBACK, 0)
        }
        val anchor = deleteAnchor
        if (done) {
            deleteAnchor = -1
            deleteBefore = null
            if (words > 0) {
                ic.commitText("", 1)
                lastSwipe = null; pendingSpace = false; lastAutocorrect = null; touches.clear()
            } else {
                ic.setSelection(anchor, anchor)
            }
            scheduleRefresh()
            return
        }
        val len = WordLogic.wordsBackLength(deleteBefore, words)
        ic.setSelection((anchor - len).coerceAtLeast(0), anchor)
        keyboard?.let { feedback.tick(it) }
    }

    private fun deleteWords(n: Int) {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        if (!selected.isNullOrEmpty()) { ic.commitText("", 1); return }
        val len = WordLogic.wordsBackLength(ic.getTextBeforeCursor(MAX_DELETE_LOOKBACK, 0), n)
        if (len > 0) ic.deleteSurroundingText(len, 0)
        lastSwipe = null; pendingSpace = false; lastAutocorrect = null; touches.clear()
    }

    override fun onGesture(path: List<Pt>) {
        if (deferred { onGesture(path) }) return
        val kb = keyboard ?: return
        val ic = currentInputConnection ?: return
        val dict = dictionaries[effectiveLanguage] ?: return
        val lang = effectiveLanguage
        val english = lang == Language.EN
        val decoder = SwipeDecoder(kb.letterCenters(), kb.letterKeyWidth(), kb.letterKeyHeight())
        val beforeText = ic.getTextBeforeCursor(48, 0)
        val context = WordLogic.previousWord(beforeText).ifEmpty { null }
        val model = models[lang]
        stripRunner.cancel()
        // Decode in the background; keys typed meanwhile are replayed after the word is committed.
        gestureJob = scope.launch {
            val results = withContext(engine) {
                runCatching { decoder.decode(path, dict, 5, model, context) }.onFailure { Log.w(TAG, "glide failed", it) }.getOrDefault(emptyList())
            }
            if (results.isNotEmpty() && currentInputConnection === ic && effectiveLanguage == lang) commitGesture(ic, results.map { it.word }, english, context)
            gestureJob = null
            val queued = pendingInput.toList()
            pendingInput.clear()
            queued.forEach { it() }
            scheduleRefresh()
        }
    }

    private fun commitGesture(ic: android.view.inputmethod.InputConnection, results: List<String>, english: Boolean, context: String?) {
        lastAutocorrect = null
        toolbarRequested = false
        touches.clear()
        val beforeText = ic.getTextBeforeCursor(2, 0)
        ic.beginBatchEdit()
        val prev = beforeText?.lastOrNull()
        // Capitalise after sentence punctuation too: the auto-space has not been typed yet there.
        val shiftOn = shift == ShiftState.ON || (autoCapEnabled && (prev == null || prev in ".!?"))
        val caps = shift == ShiftState.LOCKED
        val words = results.map { WordLogic.matchCase(it, "", english, shiftOn, caps) }
        if (WordLogic.needsSpaceBefore(prev)) ic.commitText(" ", 1)
        ic.commitText(words[0], 1)
        ic.endBatchEdit()
        lastSwipe = SwipeState(words[0], words.drop(1).distinct().filter { it != words[0] })
        learn(words[0], context)
        pendingSpace = true
        lastSpaceTap = 0
        if (shift == ShiftState.ON) { shift = ShiftState.OFF; applyShift() }
    }

    private fun onDelete() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        val swipe = lastSwipe
        // Backspace right after an autocorrection puts back what was typed (and remembers it).
        val ac = lastAutocorrect
        lastAutocorrect = null
        if (ac != null && selected.isNullOrEmpty()) {
            val edit = WordLogic.revertEdit(ic.getTextBeforeCursor(ac.corrected.length + ac.separator.length, 0), ac.original, ac.corrected, ac.separator)
            if (edit != null) {
                ic.beginBatchEdit()
                ic.deleteSurroundingText(edit.first, 0)
                ic.commitText(edit.second, 1)
                ic.endBatchEdit()
                learn(ac.original, null, UserDictionary.EXPLICIT_WEIGHT)
                analysisCache.clear()
                lastSwipe = null
                pendingSpace = false
                lastSpaceTap = 0
                touches.clear()
                return
            }
        }
        when {
            !selected.isNullOrEmpty() -> { ic.commitText("", 1); touches.clear() }
            // Backspace right after a glide removes the whole glided word.
            swipe != null && ic.getTextBeforeCursor(swipe.word.length, 0)?.toString() == swipe.word -> {
                ic.deleteSurroundingText(swipe.word.length, 0)
                touches.clear()
            }
            else -> {
                sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
                if (touches.isNotEmpty()) touches.removeAt(touches.size - 1)
            }
        }
        lastSwipe = null
        pendingSpace = false
        lastSpaceTap = 0
    }

    private fun onSpace(afterSwipe: Boolean = false) {
        val ic = currentInputConnection ?: return
        val now = SystemClock.uptimeMillis()
        // Double-space inserts ". " after a word (not in passwords / pads).
        if (!isPasswordField && mode == Mode.ALPHA && now - lastSpaceTap < DOUBLE_SPACE_MS) {
            val before = ic.getTextBeforeCursor(2, 0)
            if (before != null && before.length == 2 && before[1] == ' ' && Character.isLetterOrDigit(before[0])) {
                ic.deleteSurroundingText(1, 0)
                ic.commitText(". ", 1)
                lastSpaceTap = 0
                return
            }
        }
        onWordBoundary(" ", fromSwipe = afterSwipe, correct = true)
        ic.commitText(" ", 1)
        lastSpaceTap = now
    }

    /**
     * A separator ([separator], committed by the caller right after) ends the word before the
     * cursor: autocorrect it when confident, and learn it. Glided words were learned already.
     *
     * The analysis is normally cached from the strip (computed in the background while typing).
     * On a miss it is computed here within [SYNC_BUDGET_MS]; if that isn't enough (very fast typing
     * on a slow phone) it finishes in the background and the correction is applied late, only if
     * the cursor still sits right after the word and its separator.
     */
    private fun onWordBoundary(separator: String, fromSwipe: Boolean, correct: Boolean) {
        if (fromSwipe || !wordFeaturesAllowed) return
        val ic = currentInputConnection ?: return
        val before = ic.getTextBeforeCursor(64, 0) ?: return
        val after = ic.getTextAfterCursor(1, 0)
        if (!after.isNullOrEmpty() && Character.isLetterOrDigit(after[0])) return // inside a word
        val token = WordLogic.trailingWord(before)
        val word = token.trimEnd('\'', '\u2019')
        if (word.isEmpty() || WordLogic.hasDigit(word)) return
        val suffix = token.substring(word.length)
        val english = effectiveLanguage == Language.EN
        val prev = WordLogic.contextBeforeCurrent(before).ifEmpty { null }
        val camel = english && word.drop(1).any { it.isUpperCase() }
        if (!correct || !autocorrectAllowed || camel) { learn(word, prev); return }
        val t = touchesFor(word)
        val key = analysisKey(word, prev, t)
        val now = analysisCache[key] ?: analyzeWithin(word, prev, t, key)
        if (now != null) {
            val fix = now.autocorrect?.let { WordLogic.matchCase(it, word, english) }?.takeIf { it != word }
            if (fix != null) {
                ic.beginBatchEdit()
                ic.deleteSurroundingText(token.length, 0)
                ic.commitText(fix + suffix, 1)
                ic.endBatchEdit()
                lastAutocorrect = AutoCorrection(token, fix + suffix, separator)
            }
            learn(fix ?: word, prev)
            return
        }
        // Late correction.
        val s = suggesters[effectiveLanguage] ?: return
        val lang = effectiveLanguage
        scope.launch {
            val a = withContext(engine) { runCatching { s.analyze(word, prev, 6, t) }.getOrNull() }
            if (a != null) analysisCache[key] = a
            val cur = currentInputConnection
            if (cur !== ic || effectiveLanguage != lang) return@launch
            val fix = a?.autocorrect?.let { WordLogic.matchCase(it, word, english) }?.takeIf { it != word }
            val tail = token + separator
            if (fix != null && cur.getTextBeforeCursor(tail.length, 0)?.toString() == tail) {
                cur.beginBatchEdit()
                cur.deleteSurroundingText(tail.length, 0)
                cur.commitText(fix + suffix + separator, 1)
                cur.endBatchEdit()
                lastAutocorrect = AutoCorrection(token, fix + suffix, separator)
                learn(fix, prev)
            } else {
                learn(word, prev)
            }
        }
    }

    /** Analysis on the calling (main) thread, given up after [SYNC_BUDGET_MS]. */
    private fun analyzeWithin(word: String, prev: String?, t: List<Pt?>?, key: String): Suggester.Analysis? {
        val s = suggesters[effectiveLanguage] ?: return null
        val deadline = System.nanoTime() + SYNC_BUDGET_MS * 1_000_000L
        return try {
            s.analyze(word, prev, 6, t) { System.nanoTime() > deadline }.also { analysisCache[key] = it }
        } catch (_: java.util.concurrent.CancellationException) {
            null
        } catch (e: Exception) {
            Log.w(TAG, "suggest failed", e)
            null
        }
    }

    /** The recorded touches when they line up with [word] (else null: no spatial evidence). */
    private fun touchesFor(word: String): List<Pt?>? =
        if (touches.size == word.length && touches.any { it != null }) touches.toList() else null

    /** Adds a committed word (and its pair with [prev]) to the personal dictionary, when allowed. */
    private fun learn(word: String, prev: String?, weight: Int = 1) {
        if (!learningAllowed) return
        val s = suggesters[effectiveLanguage] ?: return
        val w = s.normalize(word.trimEnd('\'', '\u2019'))
        learned.learn(effectiveLanguage.tag, w, prev?.let { s.normalize(it) }, weight)
        // A word first learned from the screen, now typed or accepted: it becomes a known personal word.
        if (com.talorys.keyboard.screen.ScreenWordLearner.onUserTyped(this, effectiveLanguage.tag, w)) {
            learned.learn(effectiveLanguage.tag, w, null, UserDictionary.KNOWN_COUNT.toInt() - 1)
        }
    }

    private fun analysisKey(word: String, prev: String?, t: List<Pt?>?): String =
        effectiveLanguage.tag + "\u0001" + word + "\u0001" + prev + "\u0001" + learned.version + "\u0001" + com.talorys.keyboard.screen.ScreenWordLearner.version() + "\u0001" + (t?.hashCode() ?: 0)

    private fun onEnter() {
        val info = currentInputEditorInfo
        val ic = currentInputConnection ?: return
        val action = (info?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        val noAction = ((info?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
        if (info == null || noAction || action == EditorInfo.IME_ACTION_NONE || action == EditorInfo.IME_ACTION_UNSPECIFIED) {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        } else {
            ic.performEditorAction(action)
        }
        lastSpaceTap = 0
    }

    private fun onShift() {
        val now = SystemClock.uptimeMillis()
        val doubleTap = now - lastShiftTap < DOUBLE_TAP_SHIFT_MS
        lastShiftTap = now
        shift = when (shift) {
            ShiftState.OFF -> ShiftState.ON
            ShiftState.ON -> if (doubleTap) ShiftState.LOCKED else ShiftState.OFF
            ShiftState.LOCKED -> ShiftState.OFF
        }
        applyShift()
    }

    private fun setMode(newMode: Mode) {
        mode = newMode
        if (openPanel != Panel.NONE) setPanel(Panel.NONE)
        applyKeyboard()
        if (newMode == Mode.ALPHA) updateAutoCaps()
    }

    private fun setOneHanded(side: Int) {
        prefs.oneHanded = side
        keyboard?.oneHanded = if (mode == Mode.EMOJI) 0 else side
        scheduleRefresh()
    }

    private fun setLanguage(lang: Language) {
        language = lang
        prefs.language = lang.tag
        if (mode != Mode.NUMBER && mode != Mode.PHONE) mode = Mode.ALPHA
        shift = ShiftState.OFF
        lastSwipe = null
        pendingSpace = false
        touches.clear()
        applyKeyboard()
        updateAutoCaps()
        scheduleRefresh()
    }

    private fun subtypeLanguage(subtype: InputMethodSubtype): Language? {
        val tag = subtype.languageTag.takeIf { it.isNotEmpty() } ?: @Suppress("DEPRECATION") subtype.locale
        return if (tag.isNullOrEmpty()) null else Language.fromTag(tag)
    }

    private fun toOverlay(rect: RectF): RectF? {
        val pv = preview ?: return null
        val kb = keyboard ?: return null
        val a = IntArray(2); val b = IntArray(2)
        kb.getLocationInWindow(a); pv.getLocationInWindow(b)
        val dx = (a[0] - b[0]).toFloat(); val dy = (a[1] - b[1]).toFloat()
        return RectF(rect.left + dx, rect.top + dy, rect.right + dx, rect.bottom + dy)
    }

    private fun showPreview(label: String?, rect: RectF?) {
        val pv = preview ?: return
        if (label == null || rect == null) { pv.show(null, null); return }
        pv.show(label, toOverlay(rect))
    }

    private fun showPopup(options: List<String>?, rects: List<RectF>?, selected: Int) {
        val pv = preview ?: return
        if (options == null || rects == null) { pv.showPopup(null, null, -1); return }
        pv.showPopup(options, rects.mapNotNull { toOverlay(it) }, selected)
    }

    // ---- suggestion strip ----

    private fun scheduleRefresh() {
        mainHandler.removeCallbacks(refreshRunnable)
        mainHandler.post(refreshRunnable)
    }

    /**
     * Decides what the strip shows. Reading the text around the cursor happens here (main thread,
     * cheap IPC); ranking runs on the engine thread and the result is bound when it arrives.
     * The previous suggestions stay on screen meanwhile, so nothing flickers.
     */
    private fun refreshSuggestions() {
        val st = strip ?: return
        val ic = currentInputConnection
        val before = ic?.getTextBeforeCursor(48, 0)
        val selection = ic?.getSelectedText(0)

        // Glide alternatives stay while the cursor sits right after the glided word.
        val swipe = lastSwipe
        if (swipe != null && (before == null || !before.endsWith(swipe.word) || !selection.isNullOrEmpty())) {
            lastSwipe = null
            pendingSpace = false
        }

        val word = if (ic == null || !selection.isNullOrEmpty()) "" else {
            val after = ic.getTextAfterCursor(1, 0)
            if (!after.isNullOrEmpty() && Character.isLetter(after[0])) "" else WordLogic.trailingWord(before)
        }
        if (word.isEmpty()) touches.clear()
        val wordsOn = prefs.wordSuggestions && wordFeaturesAllowed && mode == Mode.ALPHA
        val lang = effectiveLanguage
        val english = lang == Language.EN
        val s = lastSwipe
        val suggester = suggesters[lang]
        val kb = keyboard

        when {
            toolbarRequested -> { showToolbar(); if (word.isEmpty()) updateNextChars(kb, suggester, "", before) }
            s != null -> {
                st.showSuggestions(listOf(
                    s.alternatives.getOrNull(0)?.let { alt -> Slot(alt, onClick = { replaceSwiped(alt) }) },
                    Slot(s.word, bold = true, onClick = { }),
                    s.alternatives.getOrNull(1)?.let { alt -> Slot(alt, onClick = { replaceSwiped(alt) }) },
                ))
                kb?.nextCharProbs = null
            }
            wordsOn && word.isNotEmpty() && !WordLogic.hasDigit(word) && suggester != null -> {
                val typed = word.trimEnd('\'', '\u2019').ifEmpty { word }
                val prev = WordLogic.contextBeforeCurrent(before).ifEmpty { null }
                val t = touchesFor(typed)
                val key = analysisKey(typed, prev, t)
                val acAllowed = autocorrectAllowed
                val emojiOn = prefs.emojiSuggestions
                val cached = analysisCache[key]
                if (cached != null) {
                    bindWordSlots(typed, cached, english, acAllowed, emojiOn)
                }
                stripRunner.submit({ cancelled ->
                    val a = cached ?: try {
                        suggester.analyze(typed, prev, 6, t, cancelled)
                    } catch (e: java.util.concurrent.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Log.w(TAG, "suggest failed", e); null
                    }
                    val next = runCatching { suggester.nextChars(typed, prev) }.getOrNull()
                    a to next
                }) { (a, next) ->
                    if (a != null) {
                        analysisCache[key] = a
                        if (cached == null) bindWordSlots(typed, a, english, acAllowed, emojiOn)
                    }
                    kb?.nextCharProbs = if (english && shift == ShiftState.LOCKED) null else next
                }
            }
            else -> idleStrip(wordsOn, before, selection, suggester, kb)
        }
    }

    /** Nothing being typed: clipboard chip, next-word predictions, or the toolbar. */
    private fun idleStrip(wordsOn: Boolean, before: CharSequence?, selection: CharSequence?, suggester: Suggester?, kb: KeyboardView?) {
        val st = strip ?: return
        val chip = clipChip?.takeIf { SystemClock.uptimeMillis() - clipChipAt < CLIP_CHIP_MS && !isPasswordField && selection.isNullOrEmpty() }
        if (chip == null) clipChip = null
        val canPredict = wordsOn && suggester != null && selection.isNullOrEmpty() && before != null && before.lastOrNull() == ' '
        val prev = if (canPredict) WordLogic.previousWord(before).ifEmpty { null } else null
        if (chip != null) {
            st.showSuggestions(listOf(null, clipSlot(chip), null))
        } else if (prev == null) {
            showToolbar()
        }
        if (wordsOn && suggester != null) {
            val model = models[effectiveLanguage]
            val shiftOn = shift == ShiftState.ON; val caps = shift == ShiftState.LOCKED
            val english = effectiveLanguage == Language.EN
            stripRunner.submit({ _ ->
                val preds = if (prev != null && model != null) model.predict(suggester.normalize(prev), 3) else emptyList()
                preds to runCatching { suggester.nextChars("", prev) }.getOrNull()
            }) { (preds, next) ->
                kb?.nextCharProbs = next
                if (chip != null || prev == null) return@submit
                if (preds.isEmpty()) { showToolbar(); return@submit }
                val words = preds.map { WordLogic.matchCase(it, "", english, shiftOn, caps) }
                fun slot(i: Int) = words.getOrNull(i)?.let { w -> Slot(w, bold = i == 0, onClick = { applyCompletion(w) }, onLongClick = { forgetWord(w) }) }
                strip?.showSuggestions(listOf(slot(1), slot(0), slot(2)))
            }
        } else {
            kb?.nextCharProbs = null
        }
    }

    private fun updateNextChars(kb: KeyboardView?, suggester: Suggester?, prefix: String, before: CharSequence?) {
        if (kb == null || suggester == null || !wordFeaturesAllowed || mode != Mode.ALPHA) return
        val prev = WordLogic.previousWord(before).ifEmpty { null }
        stripRunner.submit({ _ -> runCatching { suggester.nextChars(prefix, prev) }.getOrNull() }) { kb.nextCharProbs = it }
    }

    private fun bindWordSlots(typed: String, a: Suggester.Analysis, english: Boolean, acAllowed: Boolean, emojiOn: Boolean) {
        val camel = english && typed.drop(1).any { it.isUpperCase() }
        val cands = a.candidates.map { WordLogic.matchCase(it.word, typed, english) }
        val fix = if (acAllowed && !camel) a.autocorrect?.let { WordLogic.matchCase(it, typed, english) } else null
        val arranged = WordLogic.arrange(typed, cands, fix).toMutableList()
        val slots: MutableList<Slot?> = arranged.mapIndexed { i, w ->
            w?.let { wordSlot(it, bold = i == 1 && fix != null, literal = it == typed, quoted = fix != null && it == typed && fix != typed) }
        }.toMutableList()
        if (emojiOn) {
            val target = arranged.getOrNull(1) ?: typed
            EmojiSuggestions.forWord(target, !english)?.let { e ->
                slots[2] = Slot(e, description = e, onClick = { insertEmojiAfterWord(e) })
            }
        }
        strip?.showSuggestions(slots)
    }

    private fun clipSlot(item: ClipItem): Slot {
        val text = item.text.replace('\n', ' ').trim().let { if (it.length > 60) it.take(60) + "…" else it }
        return Slot(text, chip = true, icon = R.drawable.tk_ic_paste, description = getString(R.string.tk_clip_paste_desc, text), onClick = {
            currentInputConnection?.commitText(item.text, 1)
            clipChip = null
            scheduleRefresh()
        }, onLongClick = { clipChip = null; scheduleRefresh() })
    }

    private fun showToolbar() {
        val st = strip ?: return
        val badge = openPanel != Panel.TALORYS && AgentClient.get(this).isConfigured && !isPasswordField && !isOwnField && latestSuggestions.isNotEmpty()
        val tools = buildList {
            add(Tool(R.drawable.tk_ic_clipboard, getString(R.string.tk_toolbar_clipboard)) { setPanel(if (openPanel == Panel.CLIPBOARD) Panel.NONE else Panel.CLIPBOARD) })
            add(Tool(R.drawable.tk_ic_emoji, getString(R.string.tk_toolbar_emoji)) { setMode(if (mode == Mode.EMOJI) Mode.ALPHA else Mode.EMOJI) })
            if (!isPasswordField) add(Tool(R.drawable.tk_ic_sparkle, getString(R.string.tk_strip_ask_desc)) { openChat() })
            add(Tool(R.drawable.tk_ic_one_handed, getString(R.string.tk_toolbar_one_handed)) { setOneHanded(if (prefs.oneHanded == 0) 1 else 0) })
            add(Tool(R.drawable.tk_ic_settings, getString(R.string.tk_strip_settings)) { openSettings() })
            add(Tool(if (openPanel == Panel.TALORYS) R.drawable.tk_ic_keyboard else R.drawable.tk_ic_apps, getString(R.string.tk_strip_panel), badge) {
                setPanel(if (openPanel == Panel.TALORYS) Panel.NONE else Panel.TALORYS)
            })
        }
        st.showToolbar(tools)
    }

    private fun wordSlot(w: String, bold: Boolean, literal: Boolean, quoted: Boolean): Slot =
        Slot(if (quoted) "“$w”" else w, bold = bold, description = w + ". " + getString(R.string.tk_strip_suggestion_hint), onClick = {
            val valid = models[effectiveLanguage]?.isValid(suggesters[effectiveLanguage]?.normalize(w) ?: w) == true
            // Picking the literal text keeps it and teaches it at once.
            applyCompletion(w, explicit = literal && !valid)
        }, onLongClick = { forgetWord(w) })

    /** Long-press on a word suggestion: forget it if it was learned (and never suggest it again from learning). */
    private fun forgetWord(w: String) {
        val s = suggesters[effectiveLanguage] ?: return
        val key = s.normalize(w)
        when {
            learned.remove(effectiveLanguage.tag, key) -> {
                analysisCache.clear()
                Toast.makeText(this, getString(R.string.tk_strip_word_forgotten, w), Toast.LENGTH_SHORT).show()
                scope.launch(Dispatchers.IO) { learned.flush() }
                scheduleRefresh()
            }
            dictionaries[effectiveLanguage]?.contains(key) == true ->
                Toast.makeText(this, getString(R.string.tk_strip_word_builtin, w), Toast.LENGTH_SHORT).show()
        }
    }

    private fun applyCompletion(word: String, explicit: Boolean = false) {
        if (deferred { applyCompletion(word, explicit) }) return
        val ic = currentInputConnection ?: return
        keyboard?.let { feedback.keyDown(it, Codes.CHAR) }
        val before = ic.getTextBeforeCursor(48, 0)
        val cur = WordLogic.trailingWord(before)
        val prev = (if (cur.isEmpty()) WordLogic.previousWord(before) else WordLogic.contextBeforeCurrent(before)).ifEmpty { null }
        learn(word, prev, if (explicit) UserDictionary.EXPLICIT_WEIGHT else 1)
        lastAutocorrect = null
        ic.beginBatchEdit()
        if (cur.isNotEmpty()) ic.deleteSurroundingText(cur.length, 0)
        ic.commitText("$word ", 1)
        ic.endBatchEdit()
        pendingSpace = false
        lastSwipe = null
        touches.clear()
        scheduleRefresh()
    }

    /** Emoji suggestion: keeps the word as typed and adds the emoji after it. */
    private fun insertEmojiAfterWord(emoji: String) {
        val ic = currentInputConnection ?: return
        val before = ic.getTextBeforeCursor(48, 0)
        val cur = WordLogic.trailingWord(before)
        if (cur.isNotEmpty()) learn(cur, WordLogic.contextBeforeCurrent(before).ifEmpty { null })
        ic.commitText(" $emoji ", 1)
        touches.clear()
        scheduleRefresh()
    }

    private fun replaceSwiped(alt: String) {
        val ic = currentInputConnection ?: return
        val s = lastSwipe ?: return
        if (ic.getTextBeforeCursor(s.word.length, 0)?.toString() != s.word) return
        ic.beginBatchEdit()
        ic.deleteSurroundingText(s.word.length, 0)
        ic.commitText(alt, 1)
        ic.endBatchEdit()
        learn(alt, WordLogic.previousWord(ic.getTextBeforeCursor(48 + alt.length, 0)?.let { it.subSequence(0, maxOf(0, it.length - alt.length)) }).ifEmpty { null })
        lastSwipe = SwipeState(alt, listOf(s.word) + s.alternatives.filter { it != alt })
        pendingSpace = true
        scheduleRefresh()
    }

    // ---- voice ----

    /** Hands off to an enabled voice-typing IME (e.g. Google voice typing), like Gboard's mic. */
    private fun startVoiceTyping() {
        val imm = getSystemService(InputMethodManager::class.java)
        val target = runCatching {
            imm.enabledInputMethodList.filter { it.packageName != packageName }.firstNotNullOfOrNull { imi ->
                imm.getEnabledInputMethodSubtypeList(imi, true).firstOrNull { it.mode == "voice" }?.let { imi.id to it }
            }
        }.getOrNull()
        if (target == null) {
            Toast.makeText(this, R.string.tk_strip_no_voice, Toast.LENGTH_LONG).show()
            runCatching { imm.showInputMethodPicker() }
            return
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                switchInputMethod(target.first, target.second)
            } else {
                val token = window?.window?.attributes?.token ?: error("no window token")
                @Suppress("DEPRECATION")
                imm.setInputMethodAndSubtype(token, target.first, target.second)
            }
        }.onFailure {
            Log.w(TAG, "voice switch failed", it)
            runCatching { imm.showInputMethodPicker() }
        }
    }

    // ---- panels (Talorys, clipboard) ----

    private fun setPanel(which: Panel) {
        openPanel = which
        val kb = keyboard ?: return
        if (which != Panel.NONE) kb.cancelTouches()
        // BoardFrame sizes the panels to the board's height, so the keyboard never changes height.
        panel?.isVisible = which == Panel.TALORYS
        clipPanel?.isVisible = which == Panel.CLIPBOARD
        kb.visibility = if (which == Panel.NONE) View.VISIBLE else View.INVISIBLE
        if (which == Panel.CLIPBOARD) {
            clipboard.capture()
            clipChip = null
            renderClipboard()
        }
        updateAgentUi()
    }

    /** Fills the clipboard panel: pinned first, then newest first. Tap = paste, pin / delete buttons. */
    private fun renderClipboard() {
        val list = clipList ?: return
        val ctx = list.context
        list.removeAllViews()
        val items = if (prefs.clipboardHistory) clipboard.store.list() else emptyList()
        clipEmpty?.setText(if (prefs.clipboardHistory) R.string.tk_clip_empty else R.string.tk_clip_disabled)
        clipEmpty?.isVisible = items.isEmpty()
        val keyColor = themeColor(ctx, R.attr.kbKey)
        val textColor = themeColor(ctx, R.attr.kbKeyText)
        val accent = themeColor(ctx, R.attr.kbAccentKey)
        val hint = themeColor(ctx, R.attr.kbKeyHint)
        val d = resources.displayMetrics.density
        for (item in items) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = GradientDrawable().apply { setColor(keyColor); cornerRadius = 10 * d }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = (6 * d).toInt()
                }
                minimumHeight = (48 * d).toInt()
            }
            val tv = TextView(ctx).apply {
                text = item.text.trim()
                maxLines = 3
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(textColor)
                textSize = 15f
                textDirection = View.TEXT_DIRECTION_FIRST_STRONG
                setPadding((12 * d).toInt(), (10 * d).toInt(), (6 * d).toInt(), (10 * d).toInt())
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                isClickable = true
                isFocusable = true
                background = android.util.TypedValue().let { tvv ->
                    ctx.theme.resolveAttribute(android.R.attr.selectableItemBackground, tvv, true)
                    androidx.core.content.ContextCompat.getDrawable(ctx, tvv.resourceId)
                }
                contentDescription = getString(R.string.tk_clip_paste_desc, item.text.take(80))
                setOnClickListener {
                    keyboard?.let { feedback.keyDown(it, Codes.CHAR) }
                    currentInputConnection?.commitText(item.text, 1)
                }
                setOnLongClickListener {
                    clipboard.store.setPinned(item.id, !item.pinned); clipboard.persist(); renderClipboard(); true
                }
            }
            fun iconButton(icon: Int, desc: Int, tint: Int, onClick: () -> Unit) = ImageButton(ctx).apply {
                setImageResource(icon)
                imageTintList = ColorStateList.valueOf(tint)
                contentDescription = getString(desc)
                background = android.util.TypedValue().let { tvv ->
                    ctx.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tvv, true)
                    androidx.core.content.ContextCompat.getDrawable(ctx, tvv.resourceId)
                }
                layoutParams = LinearLayout.LayoutParams((44 * d).toInt(), (44 * d).toInt())
                setOnClickListener { onClick() }
            }
            row.addView(tv)
            row.addView(iconButton(R.drawable.tk_ic_pin, if (item.pinned) R.string.tk_clip_unpin else R.string.tk_clip_pin, if (item.pinned) accent else hint) {
                clipboard.store.setPinned(item.id, !item.pinned); clipboard.persist(); renderClipboard()
            })
            row.addView(iconButton(R.drawable.tk_ic_delete, R.string.tk_clip_delete, hint) {
                clipboard.store.remove(item.id); clipboard.persist(); renderClipboard()
            })
            list.addView(row)
        }
    }

    private fun updateAgentUi() {
        val configured = AgentClient.get(this).isConfigured
        val privateField = isPasswordField
        val visible = if (!configured || privateField || isOwnField) emptyList() else latestSuggestions.take(6)
        btnAsk?.isVisible = !privateField
        chipSetup?.isVisible = !configured && !isOwnField
        panelTitle?.isVisible = configured && !privateField
        panelEmpty?.isVisible = configured && !privateField && visible.isEmpty()
        panelChips?.let { group ->
            group.removeAllViews()
            for (sug in visible) {
                val chip = Chip(group.context).apply {
                    text = sug.title
                    contentDescription = sug.title + ". " + getString(R.string.tk_strip_suggestion_hint)
                    setOnClickListener {
                        currentInputConnection?.commitText(sug.body, 1)
                        companion?.accept(sug.id)
                        setPanel(Panel.NONE)
                    }
                    setOnLongClickListener { companion?.dismiss(sug.id); true }
                }
                group.addView(chip)
            }
        }
        scheduleRefresh()
    }

    private fun openChat() {
        val info = currentInputEditorInfo
        val target = info?.packageName
        val ctx = ScreenContext.forPackage(target)
        val intent = ChatActivity.intent(this, screenContext = ctx, targetPackage = target, targetFieldId = info?.fieldId ?: 0)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        launch(intent)
    }

    private fun openSettings() {
        launch(AppLink.intent(this, AppLink.KEYBOARD_SETTINGS))
    }

    private fun launch(intent: Intent) {
        try {
            startActivity(intent)
            requestHideSelf(0)
        } catch (e: Exception) {
            Log.w(TAG, "Could not open ${intent.component}", e)
        }
    }

    private fun themeColor(ctx: Context, attr: Int): Int {
        val tv = TypedValue()
        ctx.theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) ctx.getColor(tv.resourceId) else tv.data
    }

    private companion object {
        const val STRIP_DEBOUNCE_MS = 8L
        const val DOUBLE_SPACE_MS = 450L
        const val DOUBLE_TAP_SHIFT_MS = 400L
        /** The "just copied" chip shows this long after a copy. */
        const val CLIP_CHIP_MS = 60_000L
        const val MAX_DELETE_LOOKBACK = 600
        /** Longest the main thread may spend on an autocorrect analysis at a word boundary. */
        const val SYNC_BUDGET_MS = 12L
    }
}
