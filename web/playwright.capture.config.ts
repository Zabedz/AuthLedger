import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// Runs the media-capture journey (docs/media screenshots and the README video)
// against the same composed stack the e2e suite uses. Separate config on
// purpose: capture.journey.ts does not match the default spec pattern, so
// neither CI nor a plain `npm run e2e` ever runs it.
//
//   npx playwright test --config playwright.capture.config.ts
//
// The Payment Element frame needs STRIPE_PUBLISHABLE_KEY (and the create route
// needs STRIPE_SECRET_KEY) in the environment. The recorded video becomes the
// README GIF with:
//
//   webm=$(find test-results -name "*.webm" | head -1)
//   ffmpeg -y -i "$webm" -vf "fps=6,scale=900:-1:flags=lanczos,palettegen" /tmp/palette.png
//   ffmpeg -y -i "$webm" -i /tmp/palette.png \
//     -filter_complex "fps=6,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" \
//     ../docs/media/journey.gif
const apiServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
const webServer = Array.isArray(base.webServer) ? base.webServer[1] : undefined;

export default defineConfig({
  ...base,
  testMatch: /capture\.journey\.ts/,
  webServer: [
    {
      ...apiServer!,
      env: {
        ...apiServer!.env,
        ...(process.env.STRIPE_PUBLISHABLE_KEY && {
          STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
        }),
      },
    },
    ...(webServer ? [webServer] : []),
  ],
});
