import { assertDevOnlyPage } from "@/lib/devOnly";
import AccountsClient from "@/app/dev/accounts/AccountsClient";

export default function DevAccountsPage() {
  assertDevOnlyPage();
  return <AccountsClient />;
}
