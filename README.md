# 🚀 CryptoMarket - Token Marketplace

A modern, real-time cryptocurrency token marketplace similar to CoinMarketCap, built with vanilla HTML, CSS, and JavaScript. This project fetches live token price data from the XDEX API and displays it in a beautiful, responsive interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.0-green.svg)

## 📋 Table of Contents

- [Features](#features)
- [Demo](#demo)
- [Installation](#installation)
- [Usage](#usage)
- [API Integration](#api-integration)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Future Enhancements](#future-enhancements)
- [Contributing](#contributing)
- [License](#license)

## ✨ Features

- **Real-time Price Data**: Fetches live token prices from XDEX API
- **Multi-Network Support**: Supports X1 Mainnet, Ethereum, BSC, and Polygon networks
- **Search Functionality**: Search for any token by address
- **Auto-Refresh**: Automatically updates token data every 30 seconds
- **Responsive Design**: Mobile-friendly interface that works on all devices
- **Statistics Dashboard**: Displays total tokens, 24h volume, and active networks
- **Beautiful UI**: Modern gradient design with smooth animations
- **CORS Handling**: Built-in CORS proxy fallback for API requests
- **Error Handling**: Graceful error handling with user-friendly messages

## 🎯 Demo

The marketplace currently features:
- **Pepe (PEPE)** token on X1 Mainnet
- Token address: `81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ`
- Real-time price updates
- 24h price change simulation
- Market cap calculations

## 🚀 Installation

### Prerequisites

- A modern web browser (Chrome, Firefox, Safari, Edge)
- Internet connection for API calls
- (Optional) A local web server for development

### Quick Start

1. **Download the project**
   ```bash
   git clone https://github.com/yourusername/cryptomarket.git
   cd cryptomarket
   ```

2. **Open the HTML file**
   - Simply double-click `crypto-marketplace.html`
   - Or serve it using a local web server:
   
   ```bash
   # Using Python 3
   python -m http.server 8000
   
   # Using Node.js (http-server)
   npx http-server
   ```

3. **Access the application**
   - Direct file: Open `crypto-marketplace.html` in your browser
   - Local server: Navigate to `http://localhost:8000`

## 💻 Usage

### Viewing Token Data

The marketplace automatically loads the PEPE token data on startup. You'll see:
- Token rank
- Token name and symbol
- Current price in USD
- 24-hour price change percentage
- Market capitalization

### Searching for Tokens

1. Enter a token address in the search bar
2. Select the network from the dropdown (X1 Mainnet, Ethereum, BSC, or Polygon)
3. Click "Search Token" button
4. The token will be added to the list with real-time data

### Understanding the Dashboard

- **Total Tokens**: Number of tokens currently tracked
- **24h Volume**: Combined trading volume (simulated)
- **Active Networks**: Number of different blockchain networks

## 🔌 API Integration

### XDEX API

The project uses the XDEX API for fetching token price data.

**Endpoint:**
```
https://api.xdex.xyz/api/token-price/price
```

**Parameters:**
- `network`: Blockchain network (e.g., "X1 Mainnet")
- `token_address`: Contract address of the token

**Example Request:**
```javascript
fetch('https://api.xdex.xyz/api/token-price/price?network=X1+Mainnet&token_address=81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ')
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "network": "X1 Mainnet",
    "token_address": "81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ",
    "price": 0.0000026684635877790015,
    "price_currency": "USD"
  }
}
```

### CORS Handling

The application implements a two-tier approach to handle CORS:

1. **Direct API Call**: Attempts direct fetch from XDEX API
2. **CORS Proxy Fallback**: Uses `corsproxy.io` if direct call fails
3. **Mock Data**: Provides sample data if both methods fail

## 📁 Project Structure

```
cryptomarket/
│
├── crypto-marketplace.html    # Main HTML file with embedded CSS and JS
├── README.md                   # Project documentation
│
└── (Optional future structure)
    ├── css/
    │   └── styles.css         # Separate CSS file
    ├── js/
    │   └── app.js             # Separate JavaScript file
    └── assets/
        └── images/            # Token icons and logos
```

### Code Organization

The single-file application is organized into:

1. **HTML Structure**: Semantic markup with header, stats, and token list
2. **CSS Styling**: Modern gradient design with responsive layouts
3. **JavaScript Logic**:
   - Token data management
   - API integration functions
   - UI rendering functions
   - Event handlers
   - Auto-refresh mechanism

## ⚙️ Configuration

### Customizing Networks

To add or modify supported networks, edit the network dropdown in the HTML:

```html
<select id="networkSelect">
    <option value="X1 Mainnet">X1 Mainnet</option>
    <option value="Ethereum">Ethereum</option>
    <option value="BSC">BSC</option>
    <option value="Polygon">Polygon</option>
    <!-- Add more networks here -->
</select>
```

### Adjusting Auto-Refresh Interval

Change the refresh interval (default: 30 seconds):

```javascript
// Auto-refresh every 30 seconds
setInterval(loadTokenData, 30000); // Change 30000 to desired milliseconds
```

### Customizing Color Scheme

Modify the gradient colors in the CSS:

```css
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
/* Change to your preferred colors */
```

## 🔧 Troubleshooting

### Common Issues

#### 1. "Token not found or API error"

**Cause**: CORS restrictions or network issues

**Solutions**:
- Check browser console (F12) for specific errors
- Verify token address is correct
- Ensure you have internet connection
- Try using a CORS browser extension (for testing only)

#### 2. Data Not Updating

**Cause**: Auto-refresh may be disabled or API is down

**Solutions**:
- Refresh the page manually
- Check browser console for errors
- Verify API endpoint is accessible

#### 3. Styling Issues on Mobile

**Cause**: Browser compatibility or viewport settings

**Solutions**:
- Clear browser cache
- Ensure viewport meta tag is present
- Test on different browsers

### Debug Mode

Open browser DevTools (F12) to see:
- API responses logged to console
- Network requests in Network tab
- Any JavaScript errors in Console tab

## 🚀 Future Enhancements

### Planned Features

- [ ] **Historical Price Charts**: Integration with charting libraries (Chart.js, TradingView)
- [ ] **Token Favorites**: Save favorite tokens to localStorage
- [ ] **Price Alerts**: Notify users when price reaches target
- [ ] **Portfolio Tracker**: Track holdings and calculate P&L
- [ ] **Multi-language Support**: i18n for global users
- [ ] **Dark/Light Theme Toggle**: User preference for themes
- [ ] **Advanced Filters**: Filter by price, volume, change percentage
- [ ] **Token Details Page**: Comprehensive token information
- [ ] **Social Integration**: Twitter feeds, news, community links
- [ ] **Backend API**: Custom backend to handle CORS and caching
- [ ] **Database Integration**: Store historical data
- [ ] **User Authentication**: Personal watchlists and settings

### Technical Improvements

- [ ] Separate CSS and JavaScript into individual files
- [ ] Implement state management (Redux/MobX)
- [ ] Add unit tests (Jest)
- [ ] Set up CI/CD pipeline
- [ ] Add TypeScript for type safety
- [ ] Implement caching strategy
- [ ] Add PWA support for offline access
- [ ] Optimize performance with lazy loading

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/AmazingFeature
   ```
3. **Commit your changes**
   ```bash
   git commit -m 'Add some AmazingFeature'
   ```
4. **Push to the branch**
   ```bash
   git push origin feature/AmazingFeature
   ```
5. **Open a Pull Request**

### Contribution Guidelines

- Follow existing code style and formatting
- Add comments for complex logic
- Test your changes thoroughly
- Update documentation as needed
- Keep commits atomic and well-described

## 📝 License

This project is licensed under the MIT License - see below for details:

```
MIT License

Copyright (c) 2026 CryptoMarket

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 📞 Support

For support, questions, or feedback:

- **Email**: support@cryptomarket.com
- **GitHub Issues**: [Create an issue](https://github.com/yourusername/cryptomarket/issues)
- **Discord**: Join our community server
- **Twitter**: [@CryptoMarket](https://twitter.com/cryptomarket)

## 🙏 Acknowledgments

- **XDEX** for providing the API
- **CoinMarketCap** for design inspiration
- **The crypto community** for feedback and support

## 📊 Project Stats

- **Lines of Code**: ~450
- **File Size**: ~15KB
- **Load Time**: <1 second
- **Browser Support**: All modern browsers
- **Mobile Friendly**: Yes
- **Dependencies**: Zero (vanilla JavaScript)

---

**Built with ❤️ for the crypto community**

*Last Updated: January 2, 2026*
