// The few DOM helpers the page needs. Text always goes in as text, never as markup.

type Child = Node | string | null | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== false) element.append(child);
  return element;
}

export function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const element = h("button", { type: "button" }, label);
  element.disabled = disabled;
  element.addEventListener("click", onClick);
  return element;
}

export function field(
  label: string,
  value: string,
  onInput: (value: string) => void,
  attributes: Readonly<Record<string, string>> = {},
): HTMLLabelElement {
  const input = h("input", { autocomplete: "off", spellcheck: "false", ...attributes });
  input.value = value;
  input.addEventListener("input", () => {
    onInput(input.value);
  });
  return h("label", {}, label, input);
}
