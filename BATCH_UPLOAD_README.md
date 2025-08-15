# Batch Upload Script

This script uploads all MP3 files from the `music/` directory along with their corresponding cover images to Vercel blob storage and creates database records for each song.

## Prerequisites

1. **Environment Variables**: Make sure your `.env.local` file contains:
   ```
   BLOB_READ_WRITE_TOKEN=your_vercel_blob_token
   ADMIN_UPLOAD_KEY=batch-upload-secret-key-2024
   NEXTAUTH_URL=http://localhost:3000
   ```

2. **File Structure**: Ensure your music files are organized as:
   ```
   music/
   ├── Artist Name - Song Title.mp3
   ├── Another Artist - Another Song.mp3
   └── images/
       ├── Artist Name - Song Title.jpg
       └── Another Artist - Another Song.jpg
   ```

3. **Next.js App Running**: The API needs to be accessible, so make sure your Next.js app is running:
   ```bash
   npm run dev
   ```

## How it Works

1. **File Parsing**: The script parses filenames in the format "Artist - Title.mp3" to extract artist and title information.

2. **Image Matching**: For each MP3 file, it looks for a corresponding JPG file in the `music/images/` directory with the same base name.

3. **Upload Process**: Uses the admin API endpoint to:
   - Upload both the MP3 and image files to Vercel blob storage
   - Create database records with the uploaded file URLs

4. **Progress Tracking**: Shows progress for each file and a summary at the end.

## Usage

1. **Run the script**:
   ```bash
   node batch-upload.js
   ```

2. **Monitor progress**: The script will show progress for each file:
   ```
   Processing: Artist Name - Song Title.mp3
     Artist: Artist Name
     Title: Song Title
     Found image: Artist Name - Song Title.jpg
     ✅ Upload successful: ID 123
   ```

3. **Check results**: At the end, you'll see a summary:
   ```
   🎉 Upload complete!
   ✅ Successfully uploaded: 85 songs
   ❌ Errors: 0 songs
   ```

## Error Handling

- **Missing images**: If no corresponding image is found, the song is skipped
- **Upload failures**: Individual upload failures are logged but don't stop the entire process
- **Rate limiting**: The script includes a 1-second delay between uploads to avoid overwhelming the API

## File Naming Tips

- Use the format "Artist - Title.mp3" for best results
- Avoid special characters that might cause issues with file uploads
- Ensure image files have the exact same base name as the MP3 files (just with .jpg extension)

## Important Notes

### Production vs Development
- **Recommended**: Deploy your app to Vercel first, then run this script against the production API
- **Development limitation**: The blob storage may not work correctly in local development due to Vercel's blob store configuration

### Authentication
The script uses an admin bypass in the `/api/songs` endpoint. The `ADMIN_UPLOAD_KEY` provides security for this functionality. Keep this key secure and don't commit it to version control.

### Running on Production
1. Deploy your app to Vercel
2. Update the `NEXTAUTH_URL` in your script to point to your production URL
3. Make sure the `ADMIN_UPLOAD_KEY` environment variable is set in your Vercel project settings
4. Run the script against your production API:
   ```bash
   export NEXTAUTH_URL=https://your-app.vercel.app
   export ADMIN_UPLOAD_KEY=your-admin-key
   node batch-upload.js
   ```
