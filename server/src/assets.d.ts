// esbuild 以 text loader 内联的静态资源
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "virtual:admin-ui" {
  export const js: string;
  export const css: string;
}
declare module "virtual:device-fw" {
  /** { "src/app.py": base64 } */
  export const files: Record<string, string>;
}
