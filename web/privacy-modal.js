// Privacy policy in an overlay, shared by the builder and admin pages. The content stays
// privacy.html (deep-linkable, single source), loaded lazily into a same-origin iframe on
// first open; ?embed=1 makes the page's own card the dialog (its back link hidden, the
// overlay supplies the close button). The href on the trigger stays real, so middle-click
// and open-in-new-tab still reach the standalone page.
//
// The dialog shrink-wraps: when the policy fits the viewport it takes exactly the
// content's height and nothing scrolls; only when it doesn't fit does it cap at 88vh and
// scroll inside. Re-measured on load, once the iframe's fonts settle (Montserrat shifts
// line wraps), and on window resize. No-op on pages without the overlay markup.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var link = $("privacy-link"), ov = $("privacy-overlay"), f = $("privacy-frame"), x = $("privacy-close");
  if (!link || !ov || !f || !x) return;
  function size() {
    if (ov.classList.contains("d-none")) return;   // hidden means zero-size layout, skip
    var h = 0;
    try {
      var c = f.contentDocument && f.contentDocument.querySelector(".doc-card");
      if (c) h = Math.ceil(c.getBoundingClientRect().height);
    } catch (e) { /* not loaded yet */ }
    var cap = Math.round(window.innerHeight * 0.88);
    f.parentElement.style.height = (h && h < cap ? h : cap) + "px";
  }
  link.addEventListener("click", function (e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    if (!f.getAttribute("src")) {
      f.addEventListener("load", function () {
        size();
        try { f.contentDocument.fonts.ready.then(size); } catch (e2) { /* older browsers */ }
      });
      f.src = "privacy.html?embed=1";
    }
    ov.classList.remove("d-none");
    size();
  });
  x.addEventListener("click", function () { ov.classList.add("d-none"); });
  ov.addEventListener("click", function (e) { if (e.target === ov) ov.classList.add("d-none"); });
  window.addEventListener("resize", size);
})();
