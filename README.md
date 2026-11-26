# PesoVivo — pesagem de bovinos por imagem, sem balança

[![CI](https://github.com/Papacosta/pesovivo/actions/workflows/ci.yml/badge.svg)](https://github.com/Papacosta/pesovivo/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-TypeScript-61DAFB?logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🇬🇧 [English version](README.en.md)

**O problema:** balança de gado é cara, pesada e exige levar cada animal até ela. Muitos
produtores pesam pouco (ou nunca) e decidem venda, suplementação e manejo "no olho".

**A solução:** um app de celular que estima o peso do boi **por foto lateral**, com o celular
preso num ponto fixo do curral. No **modo passagem**, o celular fica parado no corredor,
detecta sozinho cada animal que passa, escolhe os melhores quadros e devolve o peso com faixa
de incerteza (`412 kg ± 25 kg`). O modelo aprende **só com pesagens reais do próprio
produtor** — sem dataset de terceiros.

Construído para uso real em fazenda: funciona **offline** (sinal ruim é a regra no campo),
roda num Mac com Docker e é acessado pelo celular de qualquer lugar por um link HTTPS com senha.

## Destaques técnicos

- **Visão computacional no navegador, sem rede neural:** detector de passagem por subtração
  de fundo em quadros reduzidos, caixa por projeções e máquina de estados
  (entra → candidato → sai) que lida com animais encostados e câmera "travada"
  ([`passageDetector.ts`](frontend/src/lib/passageDetector.ts)).
- **Pipeline de ML com avaliação honesta:** segmentação YOLOv8-seg → medidas da silhueta →
  regressão Ridge / Gradient Boosting, validada com `GroupKFold` **por animal** (evita vazamento
  entre fotos do mesmo boi). Faixa de incerteza = ±1,28 × MAE da validação cruzada.
- **Agregação robusta por passagem:** mediana das estimativas por quadro, descarte de outliers
  por desvio absoluto mediano (MAD) e faixa que considera a dispersão entre quadros.
- **Offline-first:** PWA com fila no IndexedDB e UUIDs gerados no cliente, então reenvios são
  **idempotentes** (nada duplica quando a internet volta).
- **Sensores do celular:** inclinação, GPS, luz e profundidade gravados por foto (JSONB), com
  avisos de qualidade em vez de bloquear o uso.
- **Usabilidade e acessibilidade:** interface revisada pelas 10 heurísticas de Nielsen e
  WCAG 2.1 AA: contraste adequado, zoom liberado, rótulos em todos os campos, foco visível,
  anúncios para leitores de tela, validação com mensagem clara e aviso antes de perder fotos.
- **Infra:** Docker Compose (Postgres + FastAPI + nginx/HTTPS), migrações Alembic, autenticação
  no nginx, link público fixo via Tailscale Funnel e CI com GitHub Actions.

## Arquitetura

```mermaid
flowchart LR
  subgraph Celular["Celular (PWA React + TS)"]
    CAM[Câmera fixa] --> DET[Detector de passagem]
    DET --> Q[(Fila offline<br/>IndexedDB)]
  end
  Q -- HTTPS + senha --> NG[nginx]
  NG --> API[FastAPI]
  API --> DB[(PostgreSQL)]
  API --> FS[(Fotos e modelos<br/>em disco)]
  API --> ML[Segmentação YOLOv8-seg<br/>+ regressão scikit-learn]
```

| Camada | Tecnologias |
|---|---|
| Frontend | React, TypeScript, Vite, PWA (service worker), IndexedDB, Canvas, APIs de sensores |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2, Pydantic v2, Alembic, OpenCV, scikit-learn |
| ML (opcional) | Ultralytics YOLOv8-seg, PyTorch |
| Dados | PostgreSQL (JSONB), arquivos em volume |
| Infra | Docker Compose, nginx, Tailscale Funnel / Cloudflare Tunnel, GitHub Actions |

## Status

- ✅ **Fase 1 — coleta padronizada:** fotos, sensores, pesagens reais, painel, exportação CSV/ZIP.
- ✅ **Modo passagem:** captura automática e estimativa por animal.
- ✅ **Modo na mão:** um toque, de longe e com zoom 1×–5×, sem informar distância: ela é estimada pelo ângulo do celular e pela linha dos cascos ([`geometry.py`](backend/app/services/geometry.py)) e um modelo "portátil" usa medidas em cm (faixa de erro 1,5× maior); categoria escolhida antes da foto, resultado em **arrobas de carcaça** e pergunta "Saiu como esperado?".
- ✅ **Fase 2 — estimativa:** pipeline pronto e testado; **o modelo só é ativado depois de
  coletar pesagens reais suficientes** (mínimo de 30 animais). Ainda não há números de precisão
  com dados de campo.

---

## 1. Como subir tudo

Pré-requisitos: Docker + Docker Compose.

```bash
# na raiz do projeto
docker compose up --build
```

Serviços:

| Serviço | Endereço | Descrição |
|---|---|---|
| PWA | **https://localhost:5173** | frontend (nginx + HTTPS autoassinado) |
| API | http://localhost:8000 | FastAPI (Swagger em `/docs`) |
| PostgreSQL | localhost:5432 | banco `gado` / usuário `gado` / senha `gado` |

No celular, acesse `https://IP-DA-MAQUINA:5173`, aceite o aviso de certificado
autoassinado e instale o PWA na tela inicial. **A câmera exige HTTPS** (ou `localhost`);
o nginx do compose já gera o certificado na primeira subida. O app fica instalável
(manifest + service worker) e funciona offline com fila local.

Persistência:

- **Banco:** volume Docker nomeado `pgdata`.
- **Fotos e modelos:** pasta `./data` (`data/photos/`, `data/models/`), montada em `/data`.

### Acesso pelo celular de qualquer lugar (Cloudflare Tunnel)

O app roda no Mac; um túnel gratuito da Cloudflare (sem conta) cria um link `https://….trycloudflare.com`
com certificado válido, acessível pelo 4G/fazenda. **Antes**, defina usuário e senha no `.env`
(`APP_USER` / `APP_PASSWORD`): sem senha, qualquer pessoa com o link veria os dados.

```bash
docker compose --profile remoto up -d --build
docker compose logs tunnel | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
```

- No celular: abra o link, entre na tela de login do PesoVivo e use **Adicionar à tela inicial**.
  O login fica salvo por um cookie (até 400 dias). Trocar `APP_PASSWORD` desconecta todos os aparelhos.
  Não usamos HTTP Basic Auth: no iPhone, o app salvo na tela inicial não mostra a janela de senha
  e fica com a tela preta.
- O Mac precisa ficar **ligado, sem dormir**, com o Docker aberto.
- O link **muda** sempre que o túnel reinicia (ex.: Mac reiniciado). Rode o comando acima para ver o novo.
  Para um link fixo, use o Tailscale Funnel (abaixo).
- Banco (`DB_PORT`) e API (8000) ficam acessíveis só no próprio Mac; pela rede, tudo passa pelo
  frontend com senha.

### Link fixo (Tailscale Funnel, gratuito)

Endereço que não muda: `https://gado-peso.<sua-rede>.ts.net`. O celular não precisa instalar nada.

1. Crie uma conta em tailscale.com; no painel, em **DNS**, deixe **MagicDNS** ligado e ative
   **HTTPS Certificates**.
2. Gere uma auth key (Settings → Keys, sem "Ephemeral") e coloque em `TS_AUTHKEY` no `.env`.
3. Suba e ligue o Funnel (só na 1ª vez; fica salvo no volume `tsstate`). Se pedir para ativar o
   Funnel na rede, abra o link que aparecer e confirme.

```bash
docker compose --profile fixo up -d
docker compose exec funnel tailscale status --json | grep -m1 DNSName   # → gado-peso.<rede>.ts.net
echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"gado-peso.<rede>.ts.net:443":{"Handlers":{"/":{"Proxy":"https+insecure://frontend:443"}}}},"AllowFunnel":{"gado-peso.<rede>.ts.net:443":true}}' \
  | docker compose exec -T funnel tailscale serve set-raw
```

4. Coloque o endereço em `PUBLIC_URL` no `.env` e rode `docker compose --profile fixo up -d` de novo:
   o contêiner acessa o próprio link a cada minuto para mantê-lo "aquecido".

Depois que o link fixo estiver no ar, o túnel da Cloudflare pode ser desligado com
`docker compose --profile remoto stop tunnel`.

### Fase 2 (opcional, imagem mais pesada)

A segmentação usa YOLOv8-seg (pesos genéricos, classe COCO `cow`) apenas para recortar a
silhueta. As dependências pesadas são opcionais:

```bash
# .env ou ambiente
INSTALL_ML=true
SEGMENTATION_ENABLED=true

docker compose build backend
docker compose up
```

Sem isso, toda a Fase 1 funciona normalmente e a API responde que a segmentação está
desligada. O primeiro treino baixa `yolov8n-seg.pt` (gratuito, sem chave de API).

### Desenvolvimento local (opcional)

```bash
# backend (Python 3.12)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://gado:gado@localhost:5432/gado
alembic upgrade head
uvicorn app.main:app --reload

# frontend (Node 20+)
cd frontend
npm install
npm run dev
```

Em `npm run dev`, acesse pelo `localhost` (contexto seguro). Para testar no celular,
use o compose (HTTPS) ou um túnel HTTPS gratuito.

### Testes

```bash
cd backend
pip install -r requirements.txt pytest
pytest -q
```

Os testes cobrem extração de características da máscara, métricas (MAE/MAPE/RMSE/viés),
normalização de sensores ausentes, qualidade de imagem e o pipeline do estimador
(validação agrupada por animal, persistência e faixa de incerteza). Atualmente: **39 testes**.

---

## 2. Fluxo de uso no campo

1. **Cadastre o ponto de captura** (`Ajustes → Pontos` / aba Animais → Pontos na tela inicial):
   nome, celular usado, distância e altura da câmera em cm. O ponto vira o “padrão”.
2. **Cadastre o animal**: brinco/ID, raça, sexo, categoria, idade e escore (opcional).
3. **Nova coleta**: selecione ponto + animal, digite o **peso real da balança**, condições
   (luz, horário, jejum) e siga para a câmera.
4. **Capture de 3 a 5 fotos** com o checklist e o nível de inclinação. Abaixo de 3 fotos a
   sessão não é salva. Acima da tolerância de inclinação o disparo é bloqueado (com opção
   consciente de emergência).
5. **Salvar sessão** → vai para a fila local (IndexedDB) e sincroniza automaticamente.
6. Acompanhe tudo no **Painel**: totais, histograma de peso, distribuições, avisos e metas.
7. **Exporte** CSV (metadados + sensores) e ZIP (CSV + imagens) em Ajustes.
8. Quando houver **30+ animais** com fotos válidas (configurável), treine o modelo no Painel.
   A estimativa aparece na tela **Modelo & Estimativa**.

### Modo passagem (pesar sem balança)

Aba **Pesar** no menu. É o uso do dia a dia depois que existe modelo treinado:

1. Fixe o celular no tripé, **de lado para o corredor/brete**, no mesmo ponto de captura usado no treino.
2. Com o corredor **vazio**, toque em **Iniciar**: o app memoriza o fundo e mantém a tela ligada.
3. Solte o gado. Para cada animal o app detecta a entrada, **fotografa sozinho** os melhores quadros
   (inteiro no quadro, centralizado, nítido) e, quando ele sai, envia a passagem.
4. O servidor estima cada quadro, descarta quadros discrepantes e usa a **mediana** como peso.
   A faixa nunca é menor que o erro do modelo e é alargada se os quadros discordarem entre si.
5. Brinco é opcional: digite ou use um **leitor RFID Bluetooth em modo teclado**. Sem brinco, a
   passagem fica registrada por lote e horário.

Sem modelo ativo, as passagens ficam salvas como **sem modelo** e podem ser estimadas depois
(botão na própria tela ou `POST /api/passages/reestimate`).

Limitações conhecidas do detector (diferença de fundo, sem rede neural no celular):
- Animais **encostados** um no outro viram uma passagem só: use **Próximo animal** ou leia o brinco
  de cada um (um novo brinco divide a passagem).
- Mudanças fortes de luz/sombra ou objetos novos no fundo exigem **Calibrar fundo** com o corredor vazio.
- O celular **não pode se mexer** depois de calibrado.

### Protocolo de coleta (importante para a qualidade do modelo)

- **Onde marcar o chão:** marque com fita a posição das patas dianteiras e a posição do
  tripé. O mesmo enquadramento deve ser repetido em todas as coletas.
- **Distância câmera–animal:** 4 a 6 m (ex.: 450 cm). Sempre a mesma para o mesmo ponto.
- **Altura da câmera:** aproximadamente a altura do tórax do animal (1,1 a 1,4 m),
  perpendicular ao animal. Sempre a mesma.
- **Enquadramento:** foto **lateral** (perfil), animal inteiro no quadro, ninguém na frente,
  zoom **1x** e sem zoom digital. Use o overlay e a silhueta como guia.
- **Inclinação:** tripé nivelado; tolerância padrão de **5°** (ajustável em Ajustes).
- **Horário ideal:** 8h–10h e 15h–17h, com **luz difusa**. Evite sol direto na lente,
  sombras duras sobre o animal e horário de maior calor (animal agitado).
- **Quantas fotos:** **3 a 5 por animal/sessão**, na mesma sessão de pesagem, animal parado.
- **Pesagem:** registre o peso da balança imediatamente antes ou depois das fotos; anote
  se houve jejum. Não misture condições muito diferentes no mesmo lote.
- **Nunca troque distância/altura** sem criar um novo ponto de captura: isso invalida a
  comparação e a escala aprendida.
- **Diversidade:** colete raças, sexos, categorias e faixas de peso diferentes. O painel
  avisa quando faltam animais acima de 450 kg, quando há pouca diversidade de raças, etc.

### Metas

| Meta | Objetivo |
|---|---|
| **30 animais** | primeiro teste do modelo (mínimo configurável `MIN_ANIMALS_FOR_MODEL`) |
| **100+ animais** | modelo potencialmente útil em campo |
| **Cobertura de peso** | pelo menos alguns animais em cada faixa, inclusive >450 kg |
| **3–5 fotos/animal** | estabilidade da segmentação e das medidas |

---

## 3. Sensores do celular (Fase 1)

Cada foto salva um JSONB `sensors` com **leituras brutas + disponibilidade** de cada sensor.
Nada bloqueia o app por falta de sensor: o campo fica `available: false` e `null`.

Estrutura (resumida):

```json
{
  "orientation": { "available": true, "alpha": 12.3, "beta": 1.2, "gamma": -0.8, "absolute": true, "tilt_deg": 1.4 },
  "motion":      { "available": true, "acceleration": {...}, "acceleration_including_gravity": {...}, "rotation_rate": {...} },
  "camera":      { "available": true, "settings": {...}, "capabilities": {...}, "zoom": 1, "image_capture_supported": true },
  "geolocation": { "available": true, "latitude": -23.5, "longitude": -46.6, "accuracy_m": 8, "timestamp": 1730000000 },
  "ambient_light": { "available": false, "lux": 240, "source": "image_fallback" },
  "depth":       { "available": false, "distance_m": null, "method": "webxr-depth" },
  "device":      { "user_agent": "...", "platform": "..." },
  "quality":     { "warnings": ["..."], "sensor_score": 45 }
}
```

O backend normaliza o payload, calcula `tilt_deg`, estima lux pelo brilho da imagem quando
não há sensor e gera avisos. A camada de sensores do frontend é abstraída em
`frontend/src/sensors/` (interface única), permitindo trocar por ARCore/ARKit/LiDAR nativo
sem reescrever o app.

### Sensores por plataforma

| Sensor / API | Android Chrome | iOS Safari (PWA) | Limitação / fallback |
|---|---|---|---|
| Orientação (`deviceorientation`) | ✅ | ✅ com `requestPermission()` via gesto | iOS exige HTTPS e permissão explícita; `alpha` pode ser impreciso (bússola) |
| Movimento (`devicemotion`) | ✅ | ✅ com permissão | ruído; usado como leitura auxiliar |
| Nível/inclinação | ✅ | ✅ | se indisponível, o disparo não é bloqueado (apenas aviso) |
| Configurações da câmera (`getSettings`/`getCapabilities`) | ✅ parcial | ⚠️ parcial | campos como ISO/exposição/zoom variam por aparelho; salvos quando expostos |
| Forçar zoom 1x | ✅ (quando suportado) | ⚠️ raro | tenta `applyConstraints({advanced:[{zoom:1}]})`; se falhar, registra o zoom real |
| `ImageCapture` | ✅ (Chrome) | ❌ | foto é feita via canvas JPEG; `image_capture_supported` indica suporte |
| Geolocalização | ✅ com permissão | ✅ com permissão | opcional; exige HTTPS; precisão varia; nunca bloqueia |
| Luminosidade (`AmbientLightSensor`) | ⚠️ raro / flags | ❌ | fallback: brilho médio da imagem (`source: image_fallback`) |
| Profundidade (WebXR depth/hit-test) | ⚠️ Android Chrome com ARCore | ❌ | botão AR experimental; quando indisponível, `distance_m = null` |
| PWA instalável + offline | ✅ | ✅ | requer HTTPS |

---

## 4. Arquitetura

```
pesovivo/
├── docker-compose.yml         # Postgres + backend + frontend (HTTPS)
├── data/
│   ├── photos/                # fotos em disco (caminho relativo no banco)
│   └── models/                # artefatos .joblib das versões treinadas
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI + CORS + /photos
│   │   ├── config.py          # variáveis de ambiente
│   │   ├── database.py        # SQLAlchemy 2 + psycopg
│   │   ├── models.py          # capture_points, animals, weighings, photos, model_versions
│   │   ├── schemas.py         # Pydantic v2
│   │   ├── routers/           # capture_points, animals, weighings, photos, dashboard,
│   │   │                      # export, model (treino/estimativa)
│   │   └── services/
│   │       ├── sensors.py     # normalização/validação + avisos
│   │       ├── image_quality.py
│   │       ├── storage.py
│   │       ├── features.py    # medidas da máscara
│   │       ├── metrics.py     # MAE, MAPE, RMSE, viés, faixa
│   │       ├── segmentation.py# YOLOv8-seg (classe cow) atrás de interface
│   │       ├── estimator.py   # Ridge / Gradient Boosting + GroupKFold
│   │       ├── training.py    # dataset, treino, versionamento
│   │       └── estimation.py  # estimativa com modelo ativo
│   ├── alembic/               # migrações
│   └── tests/
└── frontend/
    └── src/
        ├── sensors/           # orientação, câmera, GPS, luz, profundidade
        ├── components/        # CameraView, overlay, nível, checklist, gráficos
        ├── pages/             # Home, NovaColeta, Painel, Animais, Pontos, Modelo, Ajustes
        └── lib/queue.ts       # fila IndexedDB + sincronização
```

### Banco de dados

- `capture_points`: perfil fixo da câmera (distância/altura).
- `animals`: brinco, raça, sexo, categoria, idade, escore.
- `weighings`: peso real, data, luz, horário, jejum.
- `photos`: caminho do arquivo, `sensors` JSONB, `quality` JSONB, vínculo com pesagem/animal/ponto.
- `model_versions`: versão, algoritmo, artefato, métricas, nº de animais/fotos, ativo.

Todas as chaves são UUID gerados no cliente → reenvios da fila são **idempotentes**
(não duplicam fotos/pesagens). Migrações rodam automaticamente no start do container
(`alembic upgrade head`).

### Fila offline

O frontend **sempre** grava a sessão no IndexedDB antes de enviar. A sincronização envia
na ordem `ponto → animal → pesagem → fotos`; se falhar, mantém a fila e tenta de novo ao
voltar a internet/abrir o app. O cabeçalho mostra “N na fila” e permite sincronizar.

### Exportação

- `GET /api/export/csv`: uma linha por foto, com peso real, animal, ponto, sensores JSON,
  qualidade e caminho da imagem (BOM UTF-8 para Excel).
- `GET /api/export/zip`: `dataset.csv` + `images/` + `LEIA-ME.txt`.

---

## 5. Fase 2 — pipeline de estimativa

Já implementada como infraestrutura, pronta para ativar com dados:

1. **Segmentação** (`services/segmentation.py`): YOLOv8-seg pré-treinado no COCO, restrito à
   classe **cow** (índice 19), escolhendo a maior silhueta. Interface `SegmentationProvider`
   permite trocar por modelo nativo depois. Usada **só para recortar** — nenhum peso externo.
2. **Características** (`features.py`): área, comprimento, altura do corpo, altura do tórax,
   razões (comprimento/altura, tórax/corpo, preenchimento), centróide + raça/sexo/categoria,
   idade/BCS e distância/altura/inclinação dos sensores.
3. **Regressão** (`estimator.py`): Ridge como baseline; Gradient Boosting
   (`HistGradientBoostingRegressor`) como evolução. Imputação por mediana + padronização +
   one-hot sem depender de pandas.
4. **Avaliação honesta**: `GroupKFold` **por animal** — todas as fotos do mesmo animal ficam
   no mesmo fold, evitando vazamento. Métricas: **MAE (kg), MAPE (%), RMSE, viés**, métricas
   por fold e pontos estimado × real para gráfico.
5. **Incerteza**: faixa = **±1,28 × MAE** da validação cruzada (≈80% se os erros forem
   aproximadamente normais). Ex.: `412 kg ± 25 kg`.
6. **Gate de dados**: a estimativa só aparece com modelo ativo e mínimo de animais
   (`MIN_ANIMALS_FOR_MODEL`, padrão 30); a tela mostra o erro esperado (MAE).
7. **Interface de estimador**: `WeightEstimator` (`fit`, `predict`) — trocar por CNN que usa a
   imagem diretamente não exige mudar API/app.
8. **Retreinar + histórico**: botão no Painel ou `POST /api/model/train`; cada treino cria uma
   `model_version` no PostgreSQL com métricas e artefato em `data/models/`, mantendo histórico
   e permitindo ativar uma versão anterior (`POST /api/model/activate/{id}`).

### Ativar o treino

```bash
# 1) build com ML e segmentação ligada
INSTALL_ML=true SEGMENTATION_ENABLED=true docker compose up --build

# 2) colete 30+ animais (ideal 100+)
# 3) treine pelo botão "Retreinar" no Painel ou:
curl -X POST http://localhost:8000/api/model/train \
  -H "Content-Type: application/json" \
  -d '{"algorithm":"ridge","activate":true}'
```

O treino pode demorar: segmenta cada foto de novo. Se uma foto não tiver bovino detectado,
ficar ilegível ou o animal encostar na borda, ela é registrada em `skipped` e não entra.

---

## 6. API (resumo)

| Método | Rota | Função |
|---|---|---|
| GET | `/api/health` | healthcheck |
| GET/POST | `/api/capture-points` | listar/criar (upsert idempotente) ponto |
| GET/POST | `/api/animals` | listar/criar animal |
| GET/POST | `/api/weighings` | listar/criar pesagem |
| GET | `/api/weighings/{id}/status` | completude (3–5 fotos) |
| POST | `/api/photos` | upload multipart + `sensors` JSON |
| GET | `/api/photos/{id}/file` | arquivo da foto |
| GET | `/api/dashboard/stats` | painel, histogramas, avisos, status do modelo |
| GET | `/api/export/csv` / `/zip` | exportação |
| GET | `/api/model/status` / `versions` | status/histórico |
| POST | `/api/model/train` / `/activate/{id}` | treinar/ativar |
| POST | `/api/model/estimate` | estimar peso de uma foto |
| GET/POST | `/api/passages` | listar/registrar passagens (modo passagem, vários quadros) |
| POST | `/api/passages/reestimate` | estimar passagens pendentes |
| GET | `/api/passages/{id}` | passagem com quadros e estimativa por quadro |

Documentação interativa: `http://localhost:8000/docs`.

---

## 7. Suposições registradas

1. **Escala fixa:** a câmera não muda de posição; o modelo aprende a escala implicitamente.
   Se distância/altura mudarem, crie um **novo ponto de captura**. O painel avisa quando há
   mais de um ponto.
2. **Fotos em disco**, caminho relativo no banco; volume `./data` deve ser incluído no backup.
3. **UUID no cliente** para permitir offline e sincronização idempotente.
4. **Frontend sempre enfileira antes de enviar** (mesmo online), garantindo robustez em campo.
5. **ML opcional por padrão** para manter a imagem leve; `INSTALL_ML=true` ativa.
6. **Faixa de incerteza** = ±1,28 × MAE da validação agrupada por animal.
7. **Mínimo de 30 animais** para o primeiro modelo (configurável); 100+ é a meta útil.
8. **Seed de 3–5 fotos por sessão**; o backend tolera até 7 por sessão para não perder fotos
   de uma fila offline, mas o protocolo recomendado é 3–5.
9. **Geolocalização e profundidade são opcionais** e nunca bloqueiam a coleta; quando o
   navegador não expõe um campo, ele é salvo como `null`/`available:false`.
10. **Sem serviços pagos/chaves de API:** o YOLO baixa pesos públicos na primeira execução.
11. **Certificado autoassinado** no compose para permitir câmera/PWA no celular; em produção
    troque por um certificado válido (Let's Encrypt) e restrinja `CORS_ORIGINS`.

---

## 8. Privacidade e uso

Fotos, localização e dados dos animais ficam no seu servidor/volume. O CSV/ZIP exportado
contém todo o dataset — trate como dado sensível do produtor. Não há telemetria nem envio
para terceiros.

---

## 9. Versionamento e backup

### O que entra no Git

O Git guarda apenas **código e configuração de exemplo**: backend, frontend, migrações
Alembic, `docker-compose.yml`, `Dockerfile`s, `.env.example` (sem nenhuma senha real de
produção) e os `.gitkeep` que preservam a estrutura das pastas de dados.

### O que NÃO entra no Git (e por quê)

| Item | Motivo |
|---|---|
| `data/photos/` | fotos dos animais: volume grande e dado sensível |
| `data/models/` | artefatos treinados (`.joblib`, `.pt`, `.onnx`) |
| `data/exports/` | dumps CSV/ZIP do dataset (sensível) |
| Volume do banco (`pgdata`) | dados reais das pesagens, grande e mutável |
| `.env` / `*.pem` / `*.key` | segredos e certificados |

O `.gitignore` está configurado para bloquear todos esses itens automaticamente.

### Backup regular dos dados (obrigatório em campo)

Como fotos e dados do banco ficam fora do Git, faça **backup separado** em HD externo ou
local seguro:

```bash
# 1) Copiar a pasta de fotos (e manter a estrutura data/photos)
rsync -avzh --progress data/photos/ /caminho/externo/backup/pesovivo-photos/

# 2) Gerar dump do banco PostgreSQL (via docker compose)
docker compose exec db pg_dump -U gado -d gado -Fc > backup-gado-$(date +%F).dump

# 3) Restaurar o dump (banco recém-criado, sem dados):
#    descompactação custom (-Fc) exige pg_restore no banco destino
cat backup-gado-2026-11-04.dump | docker compose exec -T db pg_restore -U gado -d gado --clean --if-exists

# 4) Testar restauração regularmente: restaure em um banco novo e valide contagens
#    de animais/pesagens/fotos antes de confiar no backup.
```

Mantenha os dumps junto das fotos no mesmo destino externo. **Sem os dois, não é possível
recuperar o sistema** (o Git não tem nem fotos nem dados das pesagens).

### Aviso importante — volume do banco

> **Nunca use `docker compose down -v` depois que existirem dados reais no banco.**
> A flag `-v` apaga o volume nomeado `pgdata` junto com **todas as pesagens, animais e
> fotos registrados** — e isso não volta de commit, pois o banco não está versionado.
> Para parar os containers use apenas `docker compose down` (sem `-v`). Se precisar
> zerar o ambiente, faça dump e backup de photos antes e depois use
> `docker compose down -v` sabendo que os dados serão perdidos.

