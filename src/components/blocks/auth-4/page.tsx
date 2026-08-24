import { Auth, type AuthProps } from './components/auth'
import { NoiseTexture } from './components/noise-texture'

export function Page({ clientName, state, error }: AuthProps) {
  return (
    <div className="bg-background relative min-h-svh w-full min-w-full overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <NoiseTexture
          className="text-foreground/[0.015] dark:text-foreground/[0.03]"
          frequency={0.5}
          octaves={5}
          slope={0.08}
          noiseOpacity={0.28}
        />
      </div>

      <div className="relative z-10 min-h-svh min-w-full">
        <Auth clientName={clientName} state={state} error={error} />
      </div>
    </div>
  )
}
