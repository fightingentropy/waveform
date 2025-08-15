#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Import fetch for Node.js (if not available globally)
const fetch = globalThis.fetch || require('node-fetch');

// Configuration
const MUSIC_DIR = './music';
const IMAGES_DIR = './music/images';
const API_BASE = process.env.NEXTAUTH_URL || 'http://localhost:3000';

// Helper function to parse filename and extract artist and title
function parseFilename(filename) {
  // Remove .mp3 extension
  const nameWithoutExt = filename.replace(/\.mp3$/, '');
  
  // Split on first ' - ' to separate artist and title
  const parts = nameWithoutExt.split(' - ');
  
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim()
    };
  } else {
    // If no ' - ' found, use filename as title and "Unknown Artist" as artist
    return {
      artist: 'Unknown Artist',
      title: nameWithoutExt.trim()
    };
  }
}

// Helper function to find corresponding image file
function findImageFile(mp3Filename) {
  const baseName = mp3Filename.replace(/\.mp3$/, '');
  const imagePath = path.join(IMAGES_DIR, `${baseName}.jpg`);
  
  if (fs.existsSync(imagePath)) {
    return imagePath;
  }
  
  return null;
}



// Main function to upload all songs
async function uploadAllSongs() {
  try {
    console.log('Starting batch upload...');
    
    // Get all MP3 files
    const mp3Files = fs.readdirSync(MUSIC_DIR)
      .filter(file => file.endsWith('.mp3'))
      .sort();
    
    console.log(`Found ${mp3Files.length} MP3 files to upload`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const mp3File of mp3Files) {
      try {
        console.log(`\nProcessing: ${mp3File}`);
        
        // Parse artist and title
        const { artist, title } = parseFilename(mp3File);
        console.log(`  Artist: ${artist}`);
        console.log(`  Title: ${title}`);
        
        // Find corresponding image
        const imagePath = findImageFile(mp3File);
        if (!imagePath) {
          console.log(`  ⚠️  No image found for ${mp3File}, skipping...`);
          continue;
        }
        
        console.log(`  Found image: ${path.basename(imagePath)}`);
        
        // Create FormData with files and metadata
        const formData = new FormData();
        formData.append('title', title);
        formData.append('artist', artist);
        
        // Add audio file
        const audioPath = path.join(MUSIC_DIR, mp3File);
        const audioBuffer = fs.readFileSync(audioPath);
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        formData.append('audio', audioBlob, mp3File);
        
        // Add image file
        const imageBuffer = fs.readFileSync(imagePath);
        const imageBlob = new Blob([imageBuffer], { type: 'image/jpeg' });
        formData.append('image', imageBlob, path.basename(imagePath));
        
        // Upload using regular songs endpoint with admin bypass
        const response = await fetch(`${API_BASE}/api/songs`, {
          method: 'POST',
          headers: {
            'X-Admin-Key': process.env.ADMIN_UPLOAD_KEY || '',
          },
          body: formData
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Upload failed: ${errorData.error || response.statusText}`);
        }
        
        const result = await response.json();
        console.log(`  ✅ Upload successful: ID ${result.song.id}`);
        
        successCount++;
        
        // Add a small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`  ❌ Error processing ${mp3File}:`, error.message);
        errorCount++;
      }
    }
    
    console.log(`\n🎉 Upload complete!`);
    console.log(`✅ Successfully uploaded: ${successCount} songs`);
    console.log(`❌ Errors: ${errorCount} songs`);
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Check if running directly
if (require.main === module) {
  // Check environment variables
  if (!process.env.ADMIN_UPLOAD_KEY) {
    console.error('❌ ADMIN_UPLOAD_KEY environment variable is required');
    console.log('Please set it in your .env.local file or export it:');
    console.log('export ADMIN_UPLOAD_KEY=your_secret_admin_key_here');
    process.exit(1);
  }
  
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN environment variable is required');
    console.log('Please set it in your .env.local file or export it:');
    console.log('export BLOB_READ_WRITE_TOKEN=your_vercel_blob_token_here');
    process.exit(1);
  }
  
  uploadAllSongs().catch(console.error);
}

module.exports = { uploadAllSongs, parseFilename };
