import { assertDevOnlyPage } from "@/lib/devOnly";
import TransfersClient from "@/app/dev/transfers/TransfersClient";

export default function DevTransfersPage() {
  assertDevOnlyPage();
  return <TransfersClient />;
}
