# Slim OpenFOAM + Python VTK image for Google Cloud Run (2 vCPU, 2-4 GiB RAM)
FROM opencfd/openfoam-run:2412

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-numpy python3-vtk9 libgl1 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    fastapi uvicorn boto3

WORKDIR /app
COPY pipe_solver.py r2_client.py server.py ./

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
