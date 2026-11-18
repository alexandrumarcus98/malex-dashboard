// Applies the saved or system theme before first paint (external file: CSP has no 'unsafe-inline').
(function () {
  var t = null;
  try { t = localStorage.getItem("theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
})();
