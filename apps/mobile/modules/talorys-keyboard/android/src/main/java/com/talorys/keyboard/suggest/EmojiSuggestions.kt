package com.talorys.keyboard.suggest

/**
 * A small keyword → emoji table (English and Hebrew) for the optional emoji suggestion in the
 * strip. Matches whole words, with Hebrew prefixes stripped (ואוהב → אוהב).
 */
object EmojiSuggestions {

    private val table: Map<String, String> = buildMap {
        fun put(emoji: String, vararg words: String) { for (w in words) putIfAbsent(w, emoji) }
        put("❤️", "love", "loved", "loving", "heart", "אוהב", "אוהבת", "אהבה", "לב", "אוהבים")
        put("😂", "lol", "haha", "hahaha", "funny", "חחח", "חחחח", "מצחיק")
        put("😊", "happy", "glad", "smile", "שמח", "שמחה", "חיוך")
        put("😢", "sad", "cry", "crying", "עצוב", "עצובה", "בוכה")
        put("👍", "ok", "okay", "good", "great", "yes", "sure", "agree", "אוקיי", "טוב", "מעולה", "בסדר", "כן", "סבבה")
        put("👎", "bad", "no", "רע")
        put("🙏", "thanks", "thank", "please", "תודה", "בבקשה")
        put("🎉", "congrats", "congratulations", "party", "birthday", "מזל", "יומולדת", "מסיבה")
        put("🔥", "fire", "hot", "lit", "אש", "חם")
        put("😴", "sleep", "tired", "sleepy", "night", "לישון", "עייף", "עייפה", "לילה")
        put("☕", "coffee", "קפה")
        put("🍕", "pizza", "פיצה")
        put("🍔", "burger", "המבורגר")
        put("🍺", "beer", "בירה")
        put("🍷", "wine", "יין")
        put("🚗", "car", "drive", "driving", "רכב", "אוטו", "נוסע")
        put("✈️", "flight", "plane", "fly", "טיסה", "מטוס")
        put("🏠", "home", "house", "בית", "הביתה")
        put("💪", "strong", "gym", "workout", "חזק", "כושר")
        put("😘", "kiss", "kisses", "נשיקה", "נשיקות")
        put("🤔", "think", "hmm", "maybe", "חושב", "אולי")
        put("😮", "wow", "וואו")
        put("😡", "angry", "mad", "כועס", "כועסת")
        put("🎂", "cake", "עוגה")
        put("🎵", "music", "song", "מוזיקה", "שיר")
        put("⚽", "football", "soccer", "כדורגל")
        put("☀️", "sun", "sunny", "morning", "שמש", "בוקר")
        put("🌧️", "rain", "גשם")
        put("💯", "perfect", "exactly", "מושלם", "בדיוק")
        put("✅", "done", "finished", "סיימתי", "בוצע")
        put("👋", "hi", "hello", "hey", "bye", "היי", "שלום", "ביי")
        put("🐶", "dog", "puppy", "כלב")
        put("🐱", "cat", "kitty", "חתול")
        put("💰", "money", "cash", "כסף")
        put("📱", "phone", "טלפון")
        put("💻", "computer", "laptop", "מחשב")
        put("🎹", "piano", "פסנתר")
    }

    /** The emoji for [word] (any case), or null. */
    fun forWord(word: String, hebrew: Boolean): String? {
        val w = if (hebrew) word else word.lowercase()
        table[w]?.let { return it }
        if (hebrew) for ((_, stem) in HebrewPrefixes.splits(w)) table[stem]?.let { return it }
        return null
    }
}
