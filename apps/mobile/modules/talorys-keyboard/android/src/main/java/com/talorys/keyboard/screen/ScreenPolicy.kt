package com.talorys.keyboard.screen

/**
 * Which apps screen-word learning skips. Pure Kotlin (unit-tested).
 *
 * Always skipped: this keyboard's own app (its settings list the learned words), the system UI
 * and anything in the user's exclusion list. The default list covers common banking / payment
 * apps and password managers; package names that look like one (bank, wallet, pay, password,
 * vault, authenticator…) are skipped too, even when not listed.
 */
object ScreenPolicy {
    /** The Talorys app, which hosts this keyboard since 0.4.0 (its settings list the learned words). */
    const val OWN_PACKAGE = "dev.talorys.app"
    /** The separate keyboard app before 0.4.0, in case it is still installed. */
    const val LEGACY_PACKAGE = "com.talorys.keyboard"

    val DEFAULT_EXCLUDED: List<String> = listOf(
        // Israeli banks and cards
        "com.leumi.leumiwallet", "com.leumi.leumidigital", "com.ideomobile.hapoalim", "com.bnhp.payments.paymentsapp",
        "com.mizrahitefahot.nh", "com.discount.app", "com.ideomobile.discount", "com.fibi.nativeapp", "com.otsar.android",
        "il.co.yahav.mobilebanking", "com.onezero.bank", "com.pepper.ldb", "il.co.isracard.mobile", "com.max.app",
        "com.cal.calapp", "com.paybox.ilwallet", "com.bitpay.wallet",
        // Payments / wallets
        "com.paypal.android.p2pmobile", "com.google.android.apps.walletnfcrel", "com.samsung.android.spay",
        "com.revolut.revolut", "com.wise.android", "com.coinbase.android", "com.binance.dev",
        // Password managers and authenticators
        "com.x8bit.bitwarden", "com.onepassword.android", "com.agilebits.onepassword", "com.lastpass.lpandroid",
        "com.dashlane", "keepass2android.keepass2android", "com.kunzisoft.keepass.free", "com.kunzisoft.keepass.libre",
        "proton.android.pass", "com.nordpass.android.app", "com.google.android.apps.authenticator2",
        "com.azure.authenticator", "com.authy.authy",
        // Talorys itself (settings list the learned words) and the old standalone keyboard app
        OWN_PACKAGE, LEGACY_PACKAGE,
    )

    private val SENSITIVE_HINTS = listOf("bank", "wallet", "pay", "password", "passwd", "vault", "keepass", "authenticator", "otp", "crypto")

    private val SYSTEM = setOf("com.android.systemui", "android")

    /** True when [pkg] must not be read. [excluded] is the user's (editable) list. */
    fun isExcluded(pkg: String?, excluded: Collection<String>): Boolean {
        if (pkg.isNullOrBlank()) return true
        val p = pkg.lowercase()
        if (p == OWN_PACKAGE || p.startsWith("$OWN_PACKAGE.") || p == LEGACY_PACKAGE || p.startsWith("$LEGACY_PACKAGE.") || p in SYSTEM) return true
        if (excluded.any { it.trim().lowercase() == p }) return true
        return SENSITIVE_HINTS.any { p.contains(it) }
    }

    /** Parses the user's list (one package per line / comma-separated), dropping blanks and junk. */
    fun parseList(text: String): List<String> =
        text.split('\n', ',', ' ', '\t').map { it.trim() }.filter { it.matches(Regex("""[A-Za-z][\w]*(\.[\w]+)+""")) }.distinct()
}
