/// <reference path="../worker-configuration.d.ts" />
/// <reference types="astro/client" />

declare module 'react' {
  interface Attributes {
    'client:load'?: boolean | string
    'client:idle'?: boolean | string
    'client:visible'?: boolean | string
    'client:media'?: string
    'client:only'?: boolean | string
  }
  interface HTMLAttributes<T> {
    'client:load'?: boolean | string
    'client:idle'?: boolean | string
    'client:visible'?: boolean | string
    'client:media'?: string
    'client:only'?: boolean | string
    class?: string
    charset?: string
    crossorigin?: string | boolean
  }
}

declare namespace App {
  interface Locals {
    runtime?: {
      env: Env
      ctx: ExecutionContext
    }
  }
}

export {}
