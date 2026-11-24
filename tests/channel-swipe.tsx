import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { ChannelPage, CHANNELS } from "../src/features/category/Category";
import "../src/index.css";

const cate = new URLSearchParams(location.search).get("cate") || "ai-duanju";
const name = CHANNELS.find(channel => channel.cate === cate)?.name || cate;

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <ChannelPage cate={cate} name={name} onBack={() => {}} wide={false} />
  </AppProvider>,
);
