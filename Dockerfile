FROM python:3.11-slim

WORKDIR /workspace

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip install --no-cache-dir \
    jupyter \
    ipykernel \
    numpy \
    pandas \
    matplotlib \
    scikit-learn

# Create kernel
RUN python3 -m ipykernel install --user --name docker-python --display-name "Python (Docker)"

CMD ["tail", "-f", "/dev/null"]
