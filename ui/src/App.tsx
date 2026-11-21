import { Button } from "@ui-sdk/react/button"
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog"
import { Preferences, usePreference } from "@ui-sdk/react/preferences"
import { colorScheme } from "./theme"

const schemes = ["system", "light", "dark"] as const

// Placeholder screen from the U5 spike. The real layout comes in U14.
export function App() {
  const { value } = usePreference(colorScheme)
  return (
    <Preferences preferences={[colorScheme]}>
      <main>
        <h1>MicroS3</h1>
        <div role="group" aria-label="Color scheme">
          {schemes.map((scheme) => (
            <Button
              key={scheme}
              aria-pressed={value === scheme}
              onClick={() => colorScheme.set(scheme)}
            >
              {scheme}
            </Button>
          ))}
        </div>
        <Dialog>
          <DialogTrigger>About</DialogTrigger>
          <DialogBackdrop />
          <DialogContent>
            <DialogTitle>MicroS3</DialogTitle>
            <DialogDescription>A small S3 emulator.</DialogDescription>
            <DialogClose data-variant="solid">Close</DialogClose>
          </DialogContent>
        </Dialog>
      </main>
    </Preferences>
  )
}
