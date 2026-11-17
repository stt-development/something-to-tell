import { vi } from "vitest";

/** JSDOM has no layout/scrolling; expose only the navigation list's fixed viewport. */
export function installProjectNavigationGeometry() {
  const height = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
  const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;
  const extent = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
  const isList = (element: HTMLElement) => element.classList.contains("project-navigation-scroll");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return isList(this) ? 288 : height.call(this); });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return isList(this) ? 224 : width.call(this); });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isList(this) ? Number.parseFloat((this.firstElementChild as HTMLElement)?.style.height ?? "0") : extent.call(this);
  });
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? this.scrollTop; this.dispatchEvent(new Event("scroll"));
  } });
  return () => {
    vi.restoreAllMocks();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  };
}
