// esbuild 以 text loader 内联的静态资源
declare module "*.html" {
  const content: string;
  export default content;
}
