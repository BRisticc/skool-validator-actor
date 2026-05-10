# Apify base image for Node.js actors
FROM apify/actor-node:20

# Copy package files and install dependencies
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional \
    && echo "Dependencies installed"

# Copy source
COPY . ./

# Run the actor
CMD npm start
