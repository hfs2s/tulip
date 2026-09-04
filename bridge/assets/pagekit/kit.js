/* Motion for pages the agent builds.
 *
 * Elements marked `.reveal` start displaced and settle as they come into view.
 * The class that hides them is added *by this script* — `is-ready` on <html> —
 * so a page whose JavaScript never runs shows all of its content rather than a
 * blank column. Progressive enhancement is not a nicety here: these pages are
 * opened by strangers on unknown phones.
 *
 * No dependencies, no network. The pages CSP is `connect-src 'none'`.
 */
(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  function start() {
    var targets = document.querySelectorAll('.reveal');
    if (targets.length === 0) return;

    if (reduced || typeof IntersectionObserver !== 'function') {
      // Nothing to animate, and nothing hidden: `is-ready` is what hides them,
      // so simply never adding it leaves the page fully visible.
      return;
    }
    root.classList.add('is-ready');

    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        // Once settled, stop watching: a reveal that replays on every scroll
        // past is a page that will not sit still to be read.
        seen.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    targets.forEach(function (el) { seen.observe(el); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
