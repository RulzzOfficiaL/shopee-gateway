#!/bin/bash
echo "======= STARTING DEPLOYMENT ======="

# 1. Update system & check dependencies
sudo apt-get update -y

if ! command -v git &> /dev/null
then
    echo "Git not found. Installing..."
    sudo apt-get install git -y
fi

if ! command -v node &> /dev/null
then
    echo "Node.js not found. Installing Node.js 18..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

if ! command -v pm2 &> /dev/null
then
    echo "PM2 not found. Installing PM2 globally..."
    sudo npm install -g pm2
fi

# 2. Setup project folder
TARGET_DIR="/var/www/shoppepay-gateway"

if [ -d "$TARGET_DIR" ]; then
    echo "Directory $TARGET_DIR exists. Pulling latest code..."
    cd $TARGET_DIR
    git pull origin main
else
    echo "Cloning repository to $TARGET_DIR..."
    sudo mkdir -p /var/www
    sudo chown -R $USER:$USER /var/www
    git clone https://github.com/ahmadzakiyox/shoppepay-api-gateway.git $TARGET_DIR
    cd $TARGET_DIR
fi

# 3. Handle dependencies
echo "Installing dependencies..."
npm install --production

# 4. Handle .env file
if [ ! -f ".env" ]; then
    echo "Creating .env from template..."
    cp .env.example .env
    echo "Please configure your .env file in $TARGET_DIR/.env later."
fi

# 5. Run under PM2
echo "Starting app under PM2..."
pm2 restart shoppepay-gateway || pm2 start server.js --name "shoppepay-gateway"
pm2 save

echo "======= DEPLOYMENT COMPLETED ======="
echo "Gateway is running on port 3001 (or your custom PORT in .env)."
echo "Log can be viewed using: pm2 logs shoppepay-gateway"
