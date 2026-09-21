FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY index.js ./
COPY payment-notify.js ./
COPY logistics-notify.js ./
EXPOSE 80
CMD ["npm", "start"]
