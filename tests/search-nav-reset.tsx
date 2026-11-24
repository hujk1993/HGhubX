import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import App from "../src/app/App";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
