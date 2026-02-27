# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy configuration files
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY . .

# Build the production application
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS runner

WORKDIR /app

# Set to production environment
ENV NODE_ENV=production

# Copy only the necessary files from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Expose the port NestJS typically runs on
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]
