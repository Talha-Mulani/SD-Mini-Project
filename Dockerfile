FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000 5001 5002 5003
CMD ["node", "gateway/server.js"]
