# PipeCFD Cloud — 浏览器 3D 管道云仿真实验室（$0/月 Serverless 架构）

基于 **Cloudflare Pages + Workers + R2 + Modal（或 Google Cloud Run）+ OpenFOAM + VTK.js** 构建的交互式 3D 管道 CFD 云仿真平台。

```
浏览器 (VTK.js 3D 渲染)
   │  静态托管 ($0, 无限流量)
   ▼
Cloudflare Pages (frontend/)
   │  POST /api/simulate  &  GET /api/results/:key/*.vtp
   ▼
Cloudflare Workers (worker/)  ───► 查重命中? ──► Cloudflare R2 ($0 流量费, 0ms 秒开!)
   │  (Turnstile + IP 限流)
   │  未命中才唤醒云端算力
   ▼
Modal Serverless / Google Cloud Run (compute/)
   │  blockMesh (3D 圆形 O-Grid 弯管) → simpleFoam → foamToVTK → 抽取 3 个轻量 .vtp (~1MB)
   └──► 结果直传 Cloudflare R2 → 返回浏览器 VTK.js 360° 渲染
```

---

## 目录结构

- `compute/pipe_solver.py`：核心 OpenFOAM 参数化 3D 圆形弯管求解器（5-Block O-Grid 网格，支持任意管径 $D$、流速 $U$、弯头角度 $15^\circ\text{–}180^\circ$、粘度 $\nu$，自动切换层流 / `kOmegaSST` 湍流）及轻量 `.vtp` 抽取器。
- `compute/local_dev_server.py`：零依赖本地联调后端（直接调用本机 `/usr/lib/openfoam/openfoam2512`）。
- `compute/modal_app.py`：Modal 云端 Serverless 算力（每月永久免费 $30 额度，按秒计费缩容到 0）。
- `compute/Dockerfile` & `compute/server.py`：Google Cloud Run 备选部署（每月免费 18 万 vCPU-秒）。
- `worker/`：Cloudflare Workers 边缘 API（参数哈希查重、R2 零流量费分发、KV 限流、Turnstile 防刷）。
- `frontend/`：Vite + React + TypeScript + **Kitware VTK.js** 3D 科学可视化前端。

---

## 一、本地一键运行（直接调用本机 OpenFOAM）

### 1. 启动本地 OpenFOAM 仿真后端
```bash
cd /home/ymxl/pipe-cfd-cloud
python3 compute/local_dev_server.py --port 8787
```

### 2. 启动前端 3D 界面
```bash
cd /home/ymxl/pipe-cfd-cloud/frontend
npm install
npm run dev
```
浏览器打开 `http://localhost:5173`，即可拖动滑块真实调用本机 OpenFOAM 求解并在浏览器 360° 查看 3D 管壁压力云图、中心截面速度云图和 3D 速度矢量箭头！

---

## 二、$0/月 上线部署（Cloudflare + Modal）

### 步骤 1：创建 Cloudflare R2 存储桶与 KV 限流库
```bash
cd worker
npm install
npx wrangler login

# 1) 创建 R2 存储桶（10 GB 免费 + 永久 $0 出口流量费）
npx wrangler r2 bucket create pipe-cfd-results

# 2) 创建 KV 命名空间用于单 IP 限流（把输出的 id 填入 worker/wrangler.toml）
npx wrangler kv namespace create RATE_LIMIT_KV
```
然后在 Cloudflare Dashboard → **R2** → **Manage R2 API Tokens** 创建一个读写该存储桶的 S3 API Token，记下：
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

### 步骤 2：部署 Modal Serverless OpenFOAM 算力（每月 $30 免费额度）
```bash
pip install modal
modal setup

# 生成一个随机鉴权密钥（Worker 与 Modal 共用）
export COMPUTE_AUTH_TOKEN=$(openssl rand -hex 24)

modal secret create pipe-cfd-secrets \
  R2_ACCOUNT_ID="你的AccountID" \
  R2_ACCESS_KEY_ID="你的R2AccessKey" \
  R2_SECRET_ACCESS_KEY="你的R2SecretKey" \
  R2_BUCKET_NAME="pipe-cfd-results" \
  COMPUTE_AUTH_TOKEN="$COMPUTE_AUTH_TOKEN"

cd /home/ymxl/pipe-cfd-cloud
modal deploy compute/modal_app.py
```
部署完成后，终端会打印一个 HTTPS Endpoint（例如 `https://<user>--pipe-cfd-openfoam-simulate.modal.run`）。

> **备选（Google Cloud Run）**：也可以用 `compute/Dockerfile` 部署到 Cloud Run：
> ```bash
> gcloud run deploy pipe-cfd-openfoam --source compute --cpu 2 --memory 2Gi --timeout 180 --allow-unauthenticated
> ```

### 步骤 3：部署 Cloudflare Worker 边缘网关
```bash
cd /home/ymxl/pipe-cfd-cloud/worker

# 配置 Worker 密钥
npx wrangler secret put COMPUTE_ENDPOINT_URL   # 填入上一步 Modal URL
npx wrangler secret put COMPUTE_AUTH_TOKEN     # 填入同一个随机密钥

# 上线部署
npx wrangler deploy
```
记下 Worker URL（例如 `https://pipe-cfd-worker.<subdomain>.workers.dev`）。

### 步骤 4：部署前端到 Cloudflare Pages
```bash
cd /home/ymxl/pipe-cfd-cloud/frontend

# 指定线上 Worker API 地址并构建
VITE_API_BASE="https://pipe-cfd-worker.<subdomain>.workers.dev" npm run build

# 一键部署到 Cloudflare Pages（免费无限流量）
npx wrangler pages deploy dist --project-name pipe-cfd-cloud
```

> **建议（防刷保护）**：上线后在 Cloudflare Dashboard 免费创建一个 **Turnstile** 站点，将 Secret Key 通过 `npx wrangler secret put TURNSTILE_SECRET_KEY` 写入 Worker，并把 `worker/wrangler.toml` 中的 `ENABLE_TURNSTILE` 改为 `"true"`。
