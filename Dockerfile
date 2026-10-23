# syntax=docker/dockerfile:1 
                                                                                                                                                                                                    
FROM node:24.22.1-bookworm AS builder                                                                                       
WORKDIR /src                                                                                                            
ARG APP_BASE_PATH=
ENV APP_BASE_PATH=${APP_BASE_PATH}
COPY package*.json ./                                                                                                   
RUN npm install                                                                                                         
COPY scripts ./scripts
COPY . .                                                                                                               
RUN npm run build                                                                                                       
                                                                                                                    
FROM node:24.22.1-bookworm                                                                                                  
WORKDIR /app                                                                                                            
ARG APP_BASE_PATH=
ENV APP_BASE_PATH=${APP_BASE_PATH}
COPY package*.json ./                                                                                                   
COPY scripts ./scripts
                                                                                                                    
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 \                                       
    libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \                       
    libgbm1 libxkbcommon0 libasound2 libcups2 xvfb                                                                      

# Disable GPU acceleration, as with it suno-api won't work in a Docker environment
ENV BROWSER_DISABLE_GPU=true
ENV HOST=0.0.0.0
ENV PORT=3000

RUN npm install --only=production                                                                                       
                                                                                                                    
# Install all supported browsers, else switching browsers requires an image rebuild                                     
RUN npx playwright install chromium                                                                                     
# RUN npx playwright install firefox                                                                                     
                                                                                                                    
COPY --from=builder /src/.next ./.next                                                                                  
EXPOSE 3000                                                                                                             
CMD ["npm", "run", "start"]
