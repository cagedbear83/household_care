import { ScrollViewStyleReset } from "expo-router/html";
import { type PropsWithChildren } from "react";

/** Web-only document shell. Runs in Node at build time, not in the browser —
 * see Expo Router's root-HTML docs; this is why it's plain inline styles
 * rather than a shared stylesheet import. Without the height:100% chain,
 * react-native-web's root view only sizes to its content instead of filling
 * the viewport. */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        <style>{`
          html, body, #root {
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            background-color: #fff;
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
