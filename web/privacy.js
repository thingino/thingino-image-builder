// Fill the retention window (.ret-mins spans) from the live limits, so the
// privacy page never drifts from the actual /api/stats value. Keeps the static
// number already in the HTML as a fallback if the fetch fails or is blocked.
(function () {
  var API = window.API_BASE || "";
  fetch(API + "/api/stats")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.retention_secs) return;
      var m = Math.max(1, Math.round(d.retention_secs / 60));
      var els = document.querySelectorAll(".ret-mins");
      for (var i = 0; i < els.length; i++) els[i].textContent = m;
    })
    .catch(function () { /* keep the static fallback */ });
})();
