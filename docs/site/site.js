const screens = {
  chat: ["מסך הצ׳אט עם פעילות הכלים", "מבקשים להוסיף משימה. פעילות הכלי והתוצאה מופיעות בתוך השיחה."],
  tasks: ["רשימת משימות עם תאריך יעד ועדיפות", "מועדי יעד, עדיפויות ותצוגות נפרדות. ניהול ידני ממשיך לעבוד גם כשאין מודל זמין."],
  memory: ["מסך הזיכרונות של Talorys במצב כהה", "אפשר לבדוק, לערוך ולמחוק את מה שהאייג׳נט זוכר. צילום הדגמה קיים, לא מידע אישי חי."],
  automations: ["מסך אוטומציות ותזכורות", "תזכורות ושגרות פועלות באמצעות שעוני Durable Object, בלי להשאיר את הדפדפן פתוח."],
  connections: ["מסך החיבורים — שירותים מחוברים ולא מחוברים", "תצוגת הסטטוס, כפתור חיבור ואפשרות ניתוק בטוחה לכל שירות. מחייב OpenConnector."],
};
const tabs = Array.from(document.querySelectorAll("[data-screen]"));
function selectTab(tab) {
  const screen = tab.dataset.screen;
  if (!screens[screen]) return;
  tabs.forEach((item) => { const selected = item === tab; item.setAttribute("aria-selected", String(selected)); item.tabIndex = selected ? 0 : -1; });
  const img = document.getElementById("tour-image");
  img.src = `./assets/${screen}.png`;
  img.alt = screens[screen][0];
  document.getElementById("tour-caption").textContent = screens[screen][1];
  document.getElementById("tour-panel").setAttribute("aria-labelledby", tab.id);
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = (index + 1) % tabs.length;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault(); tabs[next].focus(); selectTab(tabs[next]);
  });
});
document.getElementById("copy-command").addEventListener("click", async () => {
  const status = document.getElementById("copy-status");
  try { await navigator.clipboard.writeText(document.getElementById("install-command").textContent); status.textContent = "הפקודה הועתקה. אפשר להדביק בטרמינל."; }
  catch { status.textContent = "הדפדפן חסם העתקה. אפשר לסמן ולהעתיק את הפקודה ידנית."; }
});
