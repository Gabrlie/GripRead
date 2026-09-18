declare module "page-flip" {
  export interface PageFlipSettings {
    width: number;
    height: number;
    size?: "fixed" | "stretch";
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    drawShadow?: boolean;
    flippingTime?: number;
    usePortrait?: boolean;
    startPage?: number;
    autoSize?: boolean;
    showCover?: boolean;
    mobileScrollSupport?: boolean;
    swipeDistance?: number;
    clickEventForward?: boolean;
    useMouseEvents?: boolean;
    showPageCorners?: boolean;
    disableFlipByClick?: boolean;
  }

  export class PageFlip {
    public constructor(element: HTMLElement, settings: Partial<PageFlipSettings>);
    public loadFromHTML(items: HTMLElement[] | NodeListOf<HTMLElement>): void;
    public updateFromHtml(items: HTMLElement[] | NodeListOf<HTMLElement>): void;
    public turnToPage(page: number): void;
    public turnToNextPage(): void;
    public turnToPrevPage(): void;
    public flip(page: number, corner?: "top" | "bottom"): void;
    public flipNext(corner?: "top" | "bottom"): void;
    public flipPrev(corner?: "top" | "bottom"): void;
    public destroy(): void;
    public getSettings?(): PageFlipSettings;
  }
}
