import { useEffect, useRef, useState } from "react";
import Layout from "./components/Layout";
import Toaster from "./components/Toaster";
import Home from "./pages/Home";
import NovaColeta from "./pages/NovaColeta";
import Painel from "./pages/Painel";
import Animais from "./pages/Animais";
import Pontos from "./pages/Pontos";
import Ajustes from "./pages/Ajustes";
import Modelo from "./pages/Modelo";
import Passagem from "./pages/Passagem";
import NaMao from "./pages/NaMao";
import { APP_NAME } from "./lib/brand";
import { unsavedWork, setUnsavedWork } from "./lib/navGuard";

const PAGES: Record<string, { title: string; render: () => JSX.Element }> = {
  "/": { title: "Início", render: () => <Home /> },
  "/passagem": { title: "Pesar animais", render: () => <Passagem /> },
  "/na-mao": { title: "Pesar na mão", render: () => <NaMao /> },
  "/coletar": { title: "Coletar com balança", render: () => <NovaColeta /> },
  "/painel": { title: "Painel", render: () => <Painel /> },
  "/animais": { title: "Animais", render: () => <Animais /> },
  "/pontos": { title: "Pontos de captura", render: () => <Pontos /> },
  "/ajustes": { title: "Ajustes", render: () => <Ajustes /> },
  "/modelo": { title: "Modelo e estimativa", render: () => <Modelo /> },
};

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return PAGES[hash] ? hash : "/";
}

export default function App() {
  const [route, setRoute] = useState<string>(currentRoute());
  const lastRoute = useRef(route);
  const firstRender = useRef(true);

  useEffect(() => {
    const onHash = () => {
      const next = currentRoute();
      if (next === lastRoute.current) return;
      const pending = unsavedWork();
      if (pending && !window.confirm(`${pending}\n\nSair mesmo assim?`)) {
        // Volta o endereço sem trocar de tela.
        window.history.replaceState(null, "", `#${lastRoute.current}`);
        return;
      }
      setUnsavedWork(null);
      lastRoute.current = next;
      setRoute(next);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Título da aba + foco no título da tela ao navegar (leitores de tela).
  useEffect(() => {
    document.title = `${PAGES[route].title} · ${APP_NAME}`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h1 = document.querySelector<HTMLElement>("[data-page-title]");
    h1?.focus();
  }, [route]);

  return (
    <Layout route={route}>
      {PAGES[route].render()}
      <Toaster />
    </Layout>
  );
}
