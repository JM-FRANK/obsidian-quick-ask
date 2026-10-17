// A small read-only hover card. Native setTooltip accepts only a string and
// cannot give the source filename its own hierarchy or align the card's right
// edge to the quote. All elements and timers belong to the trigger's window.
function selectionHoverPosition(anchor, viewport, height) {
  const edge = 12;
  const gap = 8;
  const width = Math.max(0, Math.min(420, viewport.width - edge * 2));
  const above = Math.max(0, anchor.top - edge - gap);
  const below = Math.max(0, viewport.height - anchor.bottom - edge - gap);
  const onTop = above >= Math.min(height, 360) || above >= below;
  const maxHeight = Math.min(360, onTop ? above : below);
  const visibleHeight = Math.min(height, maxHeight);
  return {
    width, maxHeight,
    left: Math.max(edge, Math.min(anchor.right - width, viewport.width - edge - width)),
    top: onTop ? anchor.top - gap - visibleHeight : anchor.bottom + gap,
  };
}

function createSelectionHover() {
  const bindings = new Set();
  let closeActive = null;
  let nextId = 0;
  return {
    bind(trigger, selection) {
      const doc = trigger.ownerDocument;
      const owner = doc.defaultView;
      let timer = null;
      let leaveTimer = null;
      let card = null;
      const cancelLeave = () => { owner.clearTimeout(leaveTimer); leaveTimer = null; };
      const onScroll = event => { if (!card?.contains(event.target)) hide(); };
      const onKey = event => { if (event.key === 'Escape') hide(); };
      function hide() {
        owner.clearTimeout(timer); timer = null;
        cancelLeave();
        card?.remove(); card = null;
        trigger.removeAttribute('aria-describedby');
        doc.removeEventListener('scroll', onScroll, true);
        doc.removeEventListener('keydown', onKey);
        owner.removeEventListener('resize', hide);
        owner.removeEventListener('blur', hide);
        if (closeActive === hide) closeActive = null;
      }
      function show() {
        timer = null;
        if (!trigger.isConnected) return;
        const anchor = trigger.getBoundingClientRect();
        if (anchor.bottom <= 0 || anchor.top >= owner.innerHeight) return;
        closeActive?.();
        closeActive = hide;
        card = doc.createElement('div');
        card.className = 'scholar-quick-ask-selection-popover';
        card.id = `scholar-quick-ask-selection-hover-${++nextId}`;
        card.setAttribute('role', 'tooltip');
        // Carry only the configured user tint into the body-level portal.
        const tint = owner.getComputedStyle(trigger).getPropertyValue('--scholar-user-bubble-tint').trim();
        if (tint) card.style.setProperty('--scholar-user-bubble-tint', tint);
        if (selection.path) {
          const source = card.appendChild(doc.createElement('div'));
          source.className = 'scholar-quick-ask-selection-source';
          source.textContent = selection.path.split('/').at(-1);
        }
        const text = card.appendChild(doc.createElement('div'));
        text.className = 'scholar-quick-ask-selection-quote';
        text.textContent = selection.text;
        // Measure only after the wrapping width is set. Keep hidden until placed.
        card.style.visibility = 'hidden';
        card.style.width = `${selectionHoverPosition(anchor, { width: owner.innerWidth, height: owner.innerHeight }, 0).width}px`;
        doc.body.appendChild(card);
        const position = selectionHoverPosition(anchor, { width: owner.innerWidth, height: owner.innerHeight }, card.scrollHeight + 2);
        card.style.left = `${position.left}px`;
        card.style.top = `${position.top}px`;
        card.style.maxHeight = `${position.maxHeight}px`;
        card.style.visibility = '';
        trigger.setAttribute('aria-describedby', card.id);
        card.addEventListener('pointerenter', cancelLeave);
        card.addEventListener('pointerleave', leave);
        doc.addEventListener('scroll', onScroll, true);
        doc.addEventListener('keydown', onKey);
        owner.addEventListener('resize', hide);
        owner.addEventListener('blur', hide);
      }
      function enter() {
        cancelLeave();
        if (card || timer !== null) return;
        closeActive?.();
        closeActive = hide;
        timer = owner.setTimeout(show, 750);
      }
      function leave() {
        owner.clearTimeout(timer); timer = null;
        cancelLeave();
        leaveTimer = owner.setTimeout(hide, 120);
      }
      trigger.addEventListener('pointerenter', enter);
      trigger.addEventListener('pointerleave', leave);
      trigger.addEventListener('focus', enter);
      trigger.addEventListener('blur', leave);
      const dispose = () => {
        hide();
        trigger.removeEventListener('pointerenter', enter);
        trigger.removeEventListener('pointerleave', leave);
        trigger.removeEventListener('focus', enter);
        trigger.removeEventListener('blur', leave);
        bindings.delete(dispose);
      };
      bindings.add(dispose);
      return dispose;
    },
    dispose() { for (const dispose of [...bindings]) dispose(); },
  };
}

module.exports = { createSelectionHover, selectionHoverPosition };
