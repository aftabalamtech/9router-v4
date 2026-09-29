// Entry point that registers the JSX transform so tests can import the app's
// .jsx/.tsx components directly. See jsx-loader-impl.mjs.
import { register } from "node:module";
register("./jsx-loader-impl.mjs", import.meta.url);
