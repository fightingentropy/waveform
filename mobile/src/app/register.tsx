import { Redirect } from "expo-router";

// This is a private personal deployment: the production API deliberately
// disables self-registration. Keep the legacy route as a safe redirect so old
// links cannot land on a form the server will reject.
export default function RegisterRedirect() {
  return <Redirect href="/signin" />;
}
