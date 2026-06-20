export function cleanAndValidateInstagramUrl(urlStr: string): string | null {
  try {
    let cleanUrl = urlStr.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const parsed = new URL(cleanUrl);
    const hostname = parsed.hostname.toLowerCase();
    
    // Check if domain is instagram.com
    if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com') {
      return null;
    }
    
    // Path parts should be split and filtered for empty items
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }
    
    const type = pathParts[0].toLowerCase();
    if (!['p', 'reel', 'tv', 'reels'].includes(type)) {
      return null;
    }
    
    // Standardize URL structure: https://www.instagram.com/type/media_id/
    return `https://www.instagram.com/${type}/${pathParts[1]}/`;
  } catch (error) {
    return null;
  }
}
