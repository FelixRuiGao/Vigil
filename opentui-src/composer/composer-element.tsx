// Registers the self-written composer as a first-class @opentui/react intrinsic
// element (`<fermiComposer>`), so the reconciler manages its construction,
// focus, keyboard routing, ref and lifecycle exactly like the native
// <textarea> — an imperative mount cannot get focus/keyboard right.

import { extend } from "@opentui/react";

import { FermiComposerRenderable } from "./composer-renderable.js";

extend({ fermiComposer: FermiComposerRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    fermiComposer: typeof FermiComposerRenderable;
  }
}
