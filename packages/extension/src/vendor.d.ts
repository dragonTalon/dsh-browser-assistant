/**
 * Ambient module declarations for the two build-aliased runtime deps the panel
 * uses (marked + dompurify). Their real files are pulled in by `build.sh`
 * `--alias` flags pointing at the local deepseek-harness `.pnpm` store, so no
 * `@types` packages exist. Declare the minimal surface we consume.
 *
 * @module
 */

declare module 'marked' {
  export const marked: {
    parse(src: string, options?: { async?: boolean }): string | Promise<string>
  }
}

declare module 'dompurify' {
  export interface SanitizeConfig {
    ALLOWED_TAGS?: string[]
    ALLOWED_ATTR?: string[]
  }
  const DOMPurify: {
    sanitize(source: string | Node, config?: SanitizeConfig): string
  }
  export default DOMPurify
}
