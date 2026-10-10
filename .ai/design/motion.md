# Motion design

Status: planned

## Scope

Use the open-source Motion for React package through `motion/react` for interface transitions. shadcn/ui remains the control library. Simple isolated color changes can use CSS; animation ownership must remain explicit. See [Motion's React documentation](https://motion.dev/docs/react).

## Page contract

Every page design defines the trigger, start/end states, entering and exiting elements, duration/easing or spring, interruption behavior, loading/error feedback, and reduced-motion alternative. Include these with layout design rather than adding animation after implementation.

Use shared initial duration tokens: micro interaction 120 ms, ordinary transition 200 ms, and panel transition 280 ms. Use an ease-out curve for entering elements and restrained movement; settle token values centrally after device review rather than scattering overrides across pages.

| Interaction | Intended motion | Reduced-motion behavior |
| --- | --- | --- |
| Navigation | Short opacity transition, preserving destination focus and scroll | Immediate change or opacity only |
| Drawer/dialog | Backdrop fade with a small directional panel transition | No translation or scale; backdrop fade remains |
| Shelf/filter update | Stable item keys and restrained position transitions | Immediate final layout |
| Reader controls | Fade controls without reflowing text | Immediate controls or short fade |
| Async feedback | Local status transition without moving existing content | Static status with equivalent information |

## Ownership and execution

One system controls each animated property on an element. Adapt or disable overlapping component/CSS animations when Motion owns that property. Do not animate the same panel transform through both its primitive and Motion.

Interface motion must be interruptible and must not delay persistence, input handling, cancellation, or navigation completion. Repeated actions target the latest state. Prefer opacity and transforms; avoid per-character text animation, large staggered lists, and layout work on every frame. Render content independently of optional animation-feature loading.

Motion owns page and control transitions. The [reader's page-turn adapter](../subsystems/reader.md) owns page-curl rendering; Motion must not manipulate the same page transform. Reduced motion also selects the reader's instant page-turn behavior.

Reader slide/fade transitions animate an aria-hidden clone of the outgoing page or spread with the ordinary transition duration. Turns animate the whole reading screen, including margins and the header and footer, whose outgoing copies are taken before the page changes. An animated turn holds a static copy of the outgoing screen over the newly published page until the transition paints its first frame, so the next page never flashes ahead of the animation. Curl rasterizes the outgoing and incoming page or spread once per turn, drawing each character at its laid-out position, and each frame only composites those bitmaps with clip paths, a mirrored back side, and shadows; the DOM is not touched while the page moves. A backward turn plays the forward curl in reverse. Slide moves both pages and cover moves only the upper page with an edge shadow; both draw from the same rasters. A drag drives curl, slide, and cover directly from the finger, and on release the turn continues to the end or returns at Legado's speed of 300 ms per page width; a returned turn reverses the navigation without animation. Manual navigation, resize, mode/effect changes, reduced motion, and disposal cancel the active transition and settle its completion immediately. The selectable final text and saved locator never wait for decoration to finish.

Default to `MotionConfig` with `reducedMotion="user"`; use the reduced-motion preference for non-Motion effects too. Preserve focus management and accessible state even when an exit transition is interrupted. Load only needed animation features and evaluate LazyMotion when establishing the frontend bundle. See [accessibility](https://motion.dev/docs/react-accessibility) and [bundle guidance](https://motion.dev/docs/react-reduce-bundle-size).

## Acceptance

- Interrupt navigation and panel transitions repeatedly; focus, scroll, and final state remain correct.
- Enable system reduced motion and verify both general transitions and page-curl fallbacks.
- Operate by keyboard and touch without waiting for animations or losing selections.
- Profile long shelves and reader controls on target devices; verify animation does not trigger full-book layout or unnecessary persistent writes.
