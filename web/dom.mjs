// Small DOM helpers. Text is always set with textContent, never as HTML.
export const $ = id => document.getElementById(id);

export function create(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

export function button(text, action, disabled = false) {
  const b = create('button', text);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', action);
  return b;
}
