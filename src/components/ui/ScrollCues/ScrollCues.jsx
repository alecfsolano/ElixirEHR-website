import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/*
 * Site-wide cue for content that scrolls sideways (wide tables on phones, tab rows), applied once
 * per route from MainLayout. styles/scroll-cue.css holds the visuals.
 *
 * It finds every sideways scroller inside <main> that holds a table (the table itself or its
 * nearest overflow-x: auto/scroll wrapper) plus anything marked [data-scroll-cue], and keeps
 * data-scroll-cue on it up to date: "end" (more to the right), "start" (more to the left),
 * "both", or "none" (everything fits). The CSS fades the edge that has more content, so a clipped
 * column always shows that it continues. A table scroller that cannot take keyboard focus gets
 * tabindex="0" so keyboard users can scroll it too.
 */

function scrollerFor(table, main) {
  for (let element = table; element && element !== main; element = element.parentElement) {
    const { overflowX } = getComputedStyle(element);
    if (overflowX === 'auto' || overflowX === 'scroll') return element;
  }
  return null;
}

function update(element) {
  const max = element.scrollWidth - element.clientWidth;
  const atStart = element.scrollLeft <= 1;
  const atEnd = element.scrollLeft >= max - 1;
  let state = 'none';
  if (max > 1) state = atStart ? 'end' : atEnd ? 'start' : 'both';
  if (element.getAttribute('data-scroll-cue') !== state) element.setAttribute('data-scroll-cue', state);
}

function ScrollCues() {
  const { pathname } = useLocation();

  useEffect(() => {
    const main = document.querySelector('main');
    if (!main) return undefined;
    const scrollers = new Set(main.querySelectorAll('[data-scroll-cue]'));
    main.querySelectorAll('table').forEach((table) => {
      const scroller = scrollerFor(table, main);
      if (!scroller) return;
      scrollers.add(scroller);
      if (scroller.tabIndex < 0 && !scroller.hasAttribute('tabindex')) scroller.setAttribute('tabindex', '0');
    });

    const onScroll = (event) => update(event.currentTarget);
    const resize = 'ResizeObserver' in window ? new ResizeObserver((entries) => entries.forEach((entry) => update(entry.target))) : null;
    scrollers.forEach((scroller) => {
      update(scroller);
      scroller.addEventListener('scroll', onScroll, { passive: true });
      resize?.observe(scroller);
    });
    return () => {
      resize?.disconnect();
      scrollers.forEach((scroller) => scroller.removeEventListener('scroll', onScroll));
    };
  }, [pathname]);

  return null;
}

export default ScrollCues;
