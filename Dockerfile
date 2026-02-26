# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy configuration files
COPY package*.json ./

# Install all dependencies
RUN npm install

COPY . .

# Build the production application
RUN npm run build

# Stage 2: Production
# Using debian-slim instead of alpine for better Ansible/Python compatibility
FROM node:20-slim AS runner

WORKDIR /app

# 1. Install Ansible and SSH dependencies as root
USER root
RUN apt-get update && apt-get install -y \
    ansible \
    openssh-client \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set to production environment
ENV NODE_ENV=production
# Ensure Ansible doesn't hang on host key prompts
ENV ANSIBLE_HOST_KEY_CHECKING=False

# 2. Copy the necessary files from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Ensure the node user can write to /tmp for our dynamic files
RUN chmod 777 /tmp

# Switch back to node user for security
USER node

# Expose the port NestJS typically runs on
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]
